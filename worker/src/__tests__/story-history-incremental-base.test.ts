/**
 * 增量基线只许放宽范围，不许收窄。
 *
 * 线上故障（2026-09-23，云端 Job `5e4b0f67`，批次 test3）：四个仓库的
 * `base → head` 全是同一个 SHA、`range_source=PREVIOUS_SUCCESSFUL_JOB`、Commit 数 0，
 * 26 个需求全部 `NO_CANDIDATE` 并退化成全仓评审。12:33 的 `753d51e3` 一模一样。
 *
 * 根因：`fetchHistory` 只要确认"上次成功 Job 的 head 是本次 head 的祖先"就立刻采用它做 base。
 * git 认为一个提交是自己的祖先，所以两个 Job 冻结在同一个 head 时（仓库这期间没有新提交，
 * 完全正常）base==head，`base..head` 是空集。换句话说：**第一个成功的 V2 Job 会把同分支上
 * 后续每个 Job 的精准提交分析废掉**，直到仓库来了新提交。
 *
 * 正确规则：base 取 {上次成功 head, 时间窗基线} 里更老的那个 —— 批次声明的时间窗是最小
 * 覆盖面，必须始终被覆盖；上次成功 head 只在它更老时才生效。
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

interface Fixture {
  root: string
  remote: string
  work: string
  /** 由老到新：c0(08-01) c1(09-01) c2(09-20) c3(09-21) head(09-22) */
  shas: string[]
}

async function buildFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'story-history-base-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  mkdirSync(work)
  await runCommand('git', ['init', '--bare', remote])
  await runCommand('git', ['init'], { cwd: work })
  await runCommand('git', ['config', 'user.name', 'Range Developer'], { cwd: work })
  await runCommand('git', ['config', 'user.email', 'range@example.invalid'], { cwd: work })
  await runCommand('git', ['checkout', '-b', 'feature_dev'], { cwd: work })

  const shas: string[] = []
  const dates = [
    '2026-08-01T00:00:00Z',
    '2026-09-01T00:00:00Z',
    '2026-09-20T00:00:00Z',
    '2026-09-21T00:00:00Z',
    '2026-09-22T00:00:00Z',
  ]
  for (const [index, date] of dates.entries()) {
    writeFileSync(join(work, `file-${index}.txt`), `content ${index}\n`)
    await runCommand('git', ['add', '--all'], { cwd: work })
    await runCommand('git', ['commit', '-m', `commit ${index}`], {
      cwd: work,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })
    shas.push((await runCommand('git', ['rev-parse', 'HEAD'], { cwd: work })).stdout.trim())
  }
  await runCommand('git', ['remote', 'add', 'origin', `file://${remote}`], { cwd: work })
  await runCommand('git', ['push', 'origin', 'feature_dev'], { cwd: work })
  return { root, remote, work, shas }
}

async function collect(fixture: Fixture, previousBaseSha: string | null) {
  const head = fixture.shas[fixture.shas.length - 1]!
  return collectRepositoryHistory({
    prepared: {
      repository: 'kdmanage-backend',
      branch: 'feature_dev',
      commitSha: head,
      commitSubject: 'commit 4',
      path: fixture.work,
      cached: false,
    },
    cacheRoot: join(fixture.root, `cache-${previousBaseSha ?? 'none'}`),
    branch: 'feature_dev',
    headResolvedAt: '2026-09-23T00:00:00.000Z',
    // 窗口 5 天 → rangeStart=2026-09-18 → 时间窗基线是 c1(09-01)，范围内 3 个提交。
    windowDays: 5,
    prepareOptions: {
      cacheRoot: join(fixture.root, `cache-${previousBaseSha ?? 'none'}`),
      authMode: 'local',
      timeoutMs: 30_000,
    },
    remoteUrl: `file://${fixture.remote}`,
    deepenStep: 2,
    deepenLimit: 50,
    previousBaseSha,
  })
}

describe('增量基线与时间窗基线的取舍', () => {
  it('上次成功 head 等于本次 head 时不得产生空范围（线上 5e4b0f67 的根因）', async () => {
    const fixture = await buildFixture()
    const head = fixture.shas[4]!
    const result = await collect(fixture, head)

    expect(result.manifest.base_sha).toBe(fixture.shas[1])
    expect(result.manifest.base_sha).not.toBe(result.manifest.head_sha)
    expect(result.manifest.commit_count).toBe(3)
    expect(result.manifest.range_source).toBe('TIME_DERIVED')
    expect(result.manifest.range_fallback_reason).toBe('PREVIOUS_BASE_INSIDE_WINDOW')
    expect(result.manifest.enumeration_status).toBe('COMPLETE')
  })

  it('上次成功 head 落在时间窗内部时，不得把范围收窄到窗口以内', async () => {
    const fixture = await buildFixture()
    const result = await collect(fixture, fixture.shas[3]!)

    // 旧实现会取 c3 做 base，只剩 1 个提交；窗口声明的是 3 个。
    expect(result.manifest.base_sha).toBe(fixture.shas[1])
    expect(result.manifest.commit_count).toBe(3)
    expect(result.manifest.range_source).toBe('TIME_DERIVED')
    expect(result.manifest.range_fallback_reason).toBe('PREVIOUS_BASE_INSIDE_WINDOW')
  })

  it('上次成功 head 比时间窗基线更老时仍然生效（放宽方向不变）', async () => {
    const fixture = await buildFixture()
    const result = await collect(fixture, fixture.shas[0]!)

    expect(result.manifest.base_sha).toBe(fixture.shas[0])
    expect(result.manifest.commit_count).toBe(4)
    expect(result.manifest.range_source).toBe('PREVIOUS_SUCCESSFUL_JOB')
    expect(result.manifest.range_fallback_reason).toBeNull()
  })

  it('没有上次成功 Job 时行为不变', async () => {
    const fixture = await buildFixture()
    const result = await collect(fixture, null)

    expect(result.manifest.base_sha).toBe(fixture.shas[1])
    expect(result.manifest.commit_count).toBe(3)
    expect(result.manifest.range_source).toBe('TIME_DERIVED')
    expect(result.manifest.range_fallback_reason).toBeNull()
  })

  it('上次成功 head 不在本分支历史里时，回落到时间窗并记稳定原因', async () => {
    const fixture = await buildFixture()
    const result = await collect(fixture, 'f'.repeat(40))

    expect(result.manifest.base_sha).toBe(fixture.shas[1])
    expect(result.manifest.range_source).toBe('TIME_DERIVED')
    expect(result.manifest.range_fallback_reason).toBe('PREVIOUS_BASE_MISSING')
  })
})
