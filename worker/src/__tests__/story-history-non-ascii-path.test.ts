/**
 * 非 ASCII 文件路径的提交清单回归。
 *
 * 背景（2026-09-22 线上 COMMIT_MANIFEST_INVALID）：`git diff-tree --numstat`
 * 在没有 `-z` 时会按 core.quotepath 把非 ASCII 路径整体加引号并逐字节转义成
 * `"docs/openapi/ERP\347\247\237...md"`。反斜杠随后被 canonicalizeCommitManifest
 * 的安全路径检查（以及 analysis_commit_file 的 CHECK 约束）拒绝，导致整个
 * Analysis Job 因为一个合法的中文文件名而失败。
 *
 * 本测试锁定两件事：
 *  1. 清单里的路径是原始 UTF-8 文本，不含引号/反斜杠转义；
 *  2. 含中文文件名的提交可以正常规范化出 manifestHash。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCommand } from '../git/run.js'
import { collectRepositoryHistory } from '../git/story-history.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'story-history-utf8-'))
  roots.push(root)
  return root
}

const NON_ASCII_PATH = 'docs/openapi/ERP租户域名迁移连接器集群接口调用文档.md'

describe('story history with non-ASCII commit paths', () => {
  it('records raw UTF-8 paths instead of git C-quoted paths', async () => {
    const root = tempRoot()
    const remote = join(root, 'remote.git')
    const work = join(root, 'work')
    mkdirSync(work)
    await runCommand('git', ['init', '--bare', remote])
    await runCommand('git', ['init'], { cwd: work })
    await runCommand('git', ['config', 'user.name', 'UTF8 Developer'], { cwd: work })
    await runCommand('git', ['config', 'user.email', 'utf8@example.invalid'], { cwd: work })
    // core.quotepath 的默认值就是 true；显式写上是为了说明测试覆盖的正是默认配置。
    await runCommand('git', ['config', 'core.quotepath', 'true'], { cwd: work })
    await runCommand('git', ['checkout', '-b', 'feature_dev'], { cwd: work })

    const commit = async (date: string, message: string) => {
      await runCommand('git', ['add', '--all'], { cwd: work })
      await runCommand('git', ['commit', '-m', message], {
        cwd: work,
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      })
    }

    writeFileSync(join(work, 'baseline.txt'), 'baseline\n')
    await commit('2026-09-10T00:00:00Z', 'baseline')

    mkdirSync(join(work, 'docs', 'openapi'), { recursive: true })
    writeFileSync(join(work, NON_ASCII_PATH), '# 接口文档\n\n第一行\n第二行\n')
    writeFileSync(join(work, 'ascii.txt'), 'ascii\n')
    await commit('2026-09-19T12:00:00Z', 'Implement story\n\nStory-Id: PRJ-001')

    await runCommand('git', ['remote', 'add', 'origin', `file://${remote}`], { cwd: work })
    await runCommand('git', ['push', 'origin', 'feature_dev'], { cwd: work })
    const head = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: work })).stdout.trim()

    const result = await collectRepositoryHistory({
      prepared: {
        repository: 'kdmanage-backend',
        branch: 'feature_dev',
        commitSha: head,
        commitSubject: 'Implement story',
        path: work,
        cached: false,
      },
      cacheRoot: join(root, 'cache'),
      branch: 'feature_dev',
      headResolvedAt: '2026-09-19T15:00:00.000Z',
      windowDays: 1,
      prepareOptions: { cacheRoot: join(root, 'cache'), authMode: 'local', timeoutMs: 30_000 },
      remoteUrl: `file://${remote}`,
      deepenStep: 1,
      deepenLimit: 10,
    })

    expect(result.manifest.enumeration_status).toBe('COMPLETE')
    expect(result.manifest.commit_count).toBe(1)
    // 规范化没有抛 COMMIT_MANIFEST_INVALID：中文路径顺利完成冻结。
    expect(result.canonicalManifest).not.toBeNull()
    expect(result.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/)

    const files = (result.manifest.commits[0] as { files: Array<{ path: string }> }).files
    const paths = files.map((file) => file.path)
    expect(paths).toContain(NON_ASCII_PATH)
    expect(paths).toContain('ascii.txt')
    for (const path of paths) {
      expect(path).not.toContain('\\')
      expect(path).not.toContain('"')
      expect(path).not.toContain('\uFFFD')
    }
    expect(result.canonicalManifest!.commits[0]!.files.map((file) => file.path)).toContain(NON_ASCII_PATH)
  })
})
