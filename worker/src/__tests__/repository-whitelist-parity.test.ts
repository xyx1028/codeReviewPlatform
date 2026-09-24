/**
 * 仓库白名单的**两份事实来源必须一致**。
 *
 * Worker 侧是 `worker/src/git/repositories.ts` 的 `REPOSITORIES`；数据库侧是
 * `public.analysis_repository_catalog()`。它们必须是同一份清单，而且每个仓的 GitLab 项目
 * 路径也要对得上。
 *
 * 为什么值得单独一个测试：这两处不一致时的表现都不是"报错"，而是更难查的形态 ——
 *
 *   * Worker 多一个仓：`save_repository_snapshots` 以
 *     `exactly N repository snapshots are required` 拒绝整个 Job 的准备阶段；
 *   * 数据库多一个仓：Worker 只送 N-1 个快照，同一条校验反向拒绝；
 *   * 项目路径对不上：MR 采集以 `REPOSITORY_NOT_ALLOWED` 失败，而 clone 是好的，
 *     于是看起来像"GitLab 权限问题"。
 *
 * 默认跳过（需要本地 Supabase 在跑）：
 *
 * ```bash
 * RUN_LOCAL_SUPABASE_INTEGRATION=1 npx vitest run \
 *   worker/src/__tests__/repository-whitelist-parity.test.ts
 * ```
 */

import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { REPOSITORIES, REPOSITORY_NAMES } from '../git/repositories.js'

const enabled = process.env.RUN_LOCAL_SUPABASE_INTEGRATION === '1'
const localIt = enabled ? it : it.skip
const DB_CONTAINER = process.env.LOCAL_SUPABASE_DB_CONTAINER ?? 'supabase_db_codeReviewPlatform'

function psql(sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec', '-i', DB_CONTAINER,
      'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
      '-U', 'postgres', '-d', 'postgres', '-c', sql,
    ],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  ).trim()
}

describe('repository whitelist parity between the worker and the database', () => {
  localIt('lists exactly the same repository names on both sides', () => {
    const fromDb = psql(
      "select string_agg(name, ',' order by name) from unnest(public.analysis_allowed_repository_names()) as name;",
    )
    expect(fromDb.split(',')).toEqual([...REPOSITORY_NAMES].sort())
  })

  localIt('agrees on the count used by the snapshot-set contract', () => {
    expect(Number(psql('select public.analysis_allowed_repository_count();'))).toBe(
      REPOSITORY_NAMES.length,
    )
  })

  localIt('maps every repository to the GitLab project path its clone URL implies', () => {
    const rows = psql(
      "select string_agg(entry->>'name' || '=' || (entry->>'gitlab_project'), ',' order by entry->>'name') " +
        'from jsonb_array_elements(public.analysis_repository_catalog()) as entry;',
    )
    const fromDb = new Map(rows.split(',').map((pair) => pair.split('=') as [string, string]))

    for (const repository of REPOSITORIES) {
      // `/kwork/manage/tmanage-backend.git` → `kwork/manage/tmanage-backend`
      const impliedProject = repository.path.replace(/^\//, '').replace(/\.git$/, '')
      expect(fromDb.get(repository.name), `missing ${repository.name} in the SQL catalog`).toBe(
        impliedProject,
      )
    }
    expect(fromDb.size).toBe(REPOSITORIES.length)
  })

  localIt('keeps the CHECK constraints in step with the catalog', () => {
    // 两个 CHECK 刻意用字面量清单（见迁移文件头的理由），所以这里必须显式比对。
    for (const table of ['analysis_repository_snapshot', 'analysis_agent_evidence']) {
      const definition = psql(
        `select pg_get_constraintdef(oid) from pg_constraint ` +
          `where conname = '${table}_repository_name_check';`,
      )
      for (const name of REPOSITORY_NAMES) {
        expect(definition, `${table} CHECK is missing ${name}`).toContain(name)
      }
    }
  })
})
