import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentAuthorityLedger, mintRootIdentity } from '../ai/control/agent-authority-ledger.js'
import { startAttemptControlBroker, type AttemptControlHandle } from '../ai/control/attempt-control-broker.js'
import { HierarchicalBudgetLedger } from '../ai/control/hierarchical-budget-ledger.js'
import { normalizeCapabilityPolicy, policyHash } from '../ai/policy/v4-capability-policy.js'
import { SnapshotStore, STORY_DIFF_LIMITS } from '../ai/snapshot/snapshot-store.js'
import { DbError } from '../db/client.js'
import type { StoryAnalysisScope } from '../db/jobs.js'
import { runCommand } from '../git/run.js'
import { rootLogger } from '../logger.js'

const TASK_ID = '71111111-2222-4333-8444-555555555555'
const RUN_ID = '72222222-3333-4444-8555-666666666666'
const CANDIDATE_ID = '73333333-4444-4555-8666-777777777777'
const ACCESS_ID = '74444444-5555-4666-8777-888888888888'
const roots: string[] = []
const brokers: AttemptControlHandle[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'story-tools-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const broker of brokers.splice(0)) await broker.close().catch(() => undefined)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function repository(): Promise<{ gitDir: string; head: string; parent: string }> {
  const gitDir = tempRoot()
  await runCommand('git', ['init', '--quiet', '--initial-branch=main'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.email', 'tools@example.invalid'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.name', 'Story Tools'], { cwd: gitDir })
  mkdirSync(join(gitDir, 'src'))
  writeFileSync(join(gitDir, 'src/order.ts'), 'export const order = 1\n')
  writeFileSync(join(gitDir, 'src/unrelated.ts'), 'export const OUT_OF_SCOPE_DEPENDENCY = true\n')
  writeFileSync(join(gitDir, '.env'), 'SECRET=before\n')
  await runCommand('git', ['add', '--all'], { cwd: gitDir })
  await runCommand('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: gitDir })
  const parent = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: gitDir })).stdout.trim()

  const lines = Array.from({ length: 260 }, (_, index) => `export const line${index} = ${index}`).join('\n')
  writeFileSync(join(gitDir, 'src/order.ts'), `${lines}\n`)
  writeFileSync(join(gitDir, '.env'), 'SECRET=after\n')
  await runCommand('git', ['add', '--all'], { cwd: gitDir })
  await runCommand('git', ['commit', '--quiet', '-m', 'feat: implement REQ-TOOLS'], { cwd: gitDir })
  const head = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: gitDir })).stdout.trim()
  return { gitDir, head, parent }
}

function scope(head: string): StoryAnalysisScope {
  return {
    task_id: TASK_ID,
    generation: 1,
    scope_mode: 'DEVELOPER_WINDOW',
    status: 'READY',
    current_scope_level: 'PRIMARY',
    algorithm_version: 'story-attribution-v2',
    ruleset_hash: 'a'.repeat(64),
    candidate_manifest_hash: 'b'.repeat(64),
    scope_error_code: null,
    degradation_reasons: [],
    candidate_count: 1,
    strong_count: 0,
    ai_candidate_count: 1,
    triage_revision: 1,
    triage_required_count: 1,
    triage_completed_count: 0,
    triage_complete: false,
    candidates: [{
      candidate_id: CANDIDATE_ID,
      tier: 'AI_CANDIDATE',
      rank_score: 500,
      reason_codes: ['OWNER_WINDOW_MODULE'],
      repository: 'kdmanage-backend',
      files: [{ path: 'src/order.ts', old_path: null }],
      commit_sha: head,
      short_sha: head.slice(0, 12),
      subject: 'feat: implement REQ-TOOLS',
      author_name: 'Story Tools',
      author_email_masked: 't***@example.invalid',
      committed_at: '2026-09-19T00:00:00.000Z',
      files_changed: 2,
      additions: 260,
      deletions: 2,
      effective_status: 'EFFECTIVE',
      diff_status: 'UNAVAILABLE',
      triage_verdict: null,
      selected: false,
      selection_level: null,
    }],
  }
}

function post(
  broker: AttemptControlHandle,
  route: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const req = request({
      socketPath: broker.socketPath,
      path: route,
      method: 'POST',
      headers: {
        authorization: `Bearer ${broker.token}`,
        'content-type': 'application/json',
        'content-length': String(payload.byteLength),
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

async function harness(
  head: string,
  gitDir: string,
  analysisScope: StoryAnalysisScope = scope(head),
  overrides: Partial<Parameters<typeof startAttemptControlBroker>[0]> = {},
) {
  const policy = normalizeCapabilityPolicy({})
  const root = mintRootIdentity(TASK_ID, 1)
  const authority = new AgentAuthorityLedger({
    taskId: TASK_ID,
    agentAttempt: 1,
    policy,
    rootAgentId: root.rootAgentId,
    rootSessionId: root.rootSessionId,
  })
  const accesses: Array<Record<string, unknown>> = []
  const verdicts: Array<Record<string, unknown>> = []
  const expansions: Array<Record<string, unknown>> = []
  const broker = await startAttemptControlBroker({
    taskId: TASK_ID,
    agentAttempt: 1,
    sessionRevision: 1,
    snapshots: new SnapshotStore([{ name: 'kdmanage-backend', commitSha: head, gitDir }]),
    coveragePolicy: { requiredRepositories: ['kdmanage-backend'], minQueriesPerRepository: 0 },
    socketRoot: tempRoot(),
    logger: rootLogger.child({ test: 'story-commit-tools' }),
    policy,
    policyHash: policyHash(policy),
    authority,
    budget: new HierarchicalBudgetLedger({ policy }),
    analysisScope,
    analysisScopeHash: 'scope-identity',
    analysisStory: { code: 'REQ-TOOLS', name: 'Tools', allowedContext: 'controlled' },
    agentRunId: RUN_ID,
    getStoryCommitDiffMetadata: async (candidateId) => ({
      candidate_id: candidateId,
      repository_name: 'kdmanage-backend',
      commit_sha: head,
      status: 'UNAVAILABLE',
      archive_sha256: null,
    }),
    recordStoryCommitAccess: async (access) => {
      accesses.push(access)
      return ACCESS_ID
    },
    submitCommitRelevanceVerdict: async (verdict) => {
      verdicts.push(verdict as unknown as Record<string, unknown>)
      return { completed_count: 1, required_count: 1, triage_complete: true }
    },
    expandAnalysisScope: async (expansion) => { expansions.push(expansion) },
    commitReview: async () => ({ runId: 'run-result', committedAt: new Date().toISOString() }),
    isLeaseValid: () => true,
    ...overrides,
  })
  brokers.push(broker)
  const envelope = (payload: Record<string, unknown>, toolName: string) => ({
    ...payload,
    taskId: TASK_ID,
    agentAttempt: 1,
    agentCapability: authority.rootCapabilityToken,
    agentId: authority.root.agentId,
    sessionId: authority.root.sessionId,
    toolCallId: `call-${toolName}`,
    toolName,
  })
  return { broker, accesses, verdicts, expansions, envelope }
}

describe('readStoryCommitDiff', () => {
  it('reads the pinned reachable commit with byte/line paging and removes blocked paths', async () => {
    const repo = await repository()
    const store = new SnapshotStore([{ name: 'kdmanage-backend', commitSha: repo.head, gitDir: repo.gitDir }])
    const first = await store.readStoryCommitDiff({ repository: 'kdmanage-backend', candidateCommit: repo.head })
    expect(first.status).toBe('AVAILABLE')
    expect(first.content).toContain('src/order.ts')
    expect(first.content).not.toContain('.env')
    expect(first.blockedFileCount).toBe(1)
    expect(first.bytesReturned).toBeLessThanOrEqual(STORY_DIFF_LIMITS.maxPageBytes)
    expect(first.diffLines).toBeLessThanOrEqual(STORY_DIFF_LIMITS.maxPageLines)
    expect(first.nextOffset).not.toBeNull()

    await expect(store.readStoryCommitDiff({
      repository: 'kdmanage-backend', candidateCommit: repo.head, filePath: '.env',
    })).rejects.toMatchObject({ code: 'SNAPSHOT_PATH_BLOCKED' })
    await expect(store.readStoryCommitDiff({
      repository: 'kdmanage-backend', candidateCommit: repo.parent,
    })).resolves.toMatchObject({ commitSha: repo.parent })
  })
})

describe('formal story commit Broker tools', () => {
  it('accepts only candidate IDs, persists access before returning it, and rejects forged access IDs', async () => {
    const repo = await repository()
    const h = await harness(repo.head, repo.gitDir)

    const list = await post(h.broker, '/attempt/list-story-commits', h.envelope({ tier: 'ALL', limit: 1 }, 'list_story_commits'))
    expect(list.status).toBe(200)
    expect(JSON.stringify(list.body)).toContain(CANDIDATE_ID)
    expect(JSON.stringify(list.body)).not.toContain(repo.head)
    expect(list.body.items).toEqual([expect.objectContaining({
      triageVerdict: null,
      selected: false,
      selectionLevel: null,
    })])

    const forgedSha = await post(h.broker, '/attempt/list-story-commits', h.envelope({ sha: repo.head }, 'list_story_commits'))
    expect(forgedSha.status).toBe(422)
    expect(forgedSha.body.code).toBe('STORY_TOOL_ARGUMENT_INVALID')

    const diff = await post(h.broker, '/attempt/read-story-commit-diff', h.envelope({ candidateId: CANDIDATE_ID }, 'read_story_commit_diff'))
    expect(diff.status).toBe(200)
    expect(diff.body.accessId).toBe(ACCESS_ID)
    expect(h.accesses).toHaveLength(1)
    expect(h.accesses[0]).toMatchObject({ candidateId: CANDIDATE_ID, bytesReturned: expect.any(Number) })
    expect(JSON.stringify(diff.body)).not.toContain(repo.head)

    const forged = await post(h.broker, '/attempt/submit-commit-relevance', h.envelope({
      candidateId: CANDIDATE_ID,
      verdict: 'RELATED',
      reasonCodes: ['CODE_SEMANTIC_MATCH'],
      confidence: 0.9,
      diffAccessIds: ['75555555-6666-4777-8888-999999999999'],
      summary: 'forged access must fail',
    }, 'submit_commit_relevance_verdict'))
    expect(forged.status).toBe(422)
    expect(h.verdicts).toHaveLength(0)

    const accepted = await post(h.broker, '/attempt/submit-commit-relevance', h.envelope({
      candidateId: CANDIDATE_ID,
      verdict: 'RELATED',
      reasonCodes: ['CODE_SEMANTIC_MATCH'],
      confidence: 0.9,
      diffAccessIds: [ACCESS_ID],
      summary: 'The real diff implements the requirement.',
    }, 'submit_commit_relevance_verdict'))
    expect(accepted.status).toBe(200)
    expect(accepted.body).toMatchObject({ accepted: true, triageComplete: true })
    expect(h.verdicts).toHaveLength(1)
    expect(h.verdicts[0]).toMatchObject({
      scopeGeneration: 1, triageRevision: 1,
      candidateManifestHash: 'b'.repeat(64), rulesetHash: 'a'.repeat(64),
    })
  })

  it('bounds only the internal relevance envelope for an oversized frozen Unicode subject', async () => {
    const repo = await repository()
    const frozenScope = scope(repo.head)
    const frozenSubject = `${'a'.repeat(499)}😀 commit details that belong to the frozen subject`
    frozenScope.candidates[0]!.subject = frozenSubject
    const h = await harness(repo.head, repo.gitDir, frozenScope)

    const accepted = await post(h.broker, '/attempt/submit-commit-relevance', h.envelope({
      candidateId: CANDIDATE_ID,
      verdict: 'UNCERTAIN',
      reasonCodes: ['DIFF_UNAVAILABLE'],
      confidence: 0.4,
      diffAccessIds: [],
      summary: 'The frozen candidate has no readable diff.',
    }, 'submit_commit_relevance_verdict'))

    expect(accepted.status).toBe(200)
    expect(accepted.body).toMatchObject({ accepted: true, triageComplete: true })
    expect(h.verdicts).toHaveLength(1)
    expect(frozenScope.candidates[0]!.subject).toBe(frozenSubject)
    expect(frozenScope.candidates[0]!.subject.length).toBeGreaterThan(500)
  })

  it('keeps a current-run UNRELATED candidate out of PRIMARY after N/N', async () => {
    const repo = await repository()
    const h = await harness(repo.head, repo.gitDir)
    const diff = await post(h.broker, '/attempt/read-story-commit-diff', h.envelope({
      candidateId: CANDIDATE_ID,
    }, 'read_story_commit_diff'))
    expect(diff.status).toBe(200)
    const triage = await post(h.broker, '/attempt/submit-commit-relevance', h.envelope({
      candidateId: CANDIDATE_ID, verdict: 'UNRELATED', reasonCodes: ['DIFFERENT_FEATURE'],
      confidence: 0.95, diffAccessIds: [ACCESS_ID], summary: 'This commit belongs to another feature.',
    }, 'submit_commit_relevance_verdict'))
    expect(triage.body).toMatchObject({ accepted: true, triageComplete: true })

    const read = await post(h.broker, '/attempt/read-code', h.envelope({
      repository: 'kdmanage-backend', path: 'src/order.ts', startLine: 1, endLine: 2,
    }, 'read_snapshot_code'))
    expect(read.status).toBe(403)
    expect(read.body.code).toBe('SNAPSHOT_SCOPE_DENIED')
    const find = await post(h.broker, '/attempt/find-files', h.envelope({
      repository: 'kdmanage-backend', pattern: '**/*.ts',
    }, 'find_snapshot_files'))
    expect(find.status).toBe(200)
    expect(find.body.paths).toEqual([])
  })

  it('records only monotonic explicit scope expansions', async () => {
    const repo = await repository()
    const h = await harness(repo.head, repo.gitDir)
    const first = await post(h.broker, '/attempt/expand-analysis-scope', h.envelope({
      targetLevel: 'RELATED', reasonCode: 'DEPENDENCY_LOOKUP',
    }, 'expand_analysis_scope'))
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ fromLevel: 'PRIMARY', currentLevel: 'RELATED' })

    /*
     * 重复/回退的扩展请求是**成功的空操作**，不是错误。
     *
     * 旧行为回 422 `SCOPE_EXPANSION_INVALID`：在降级任务里范围本来就已经是 GLOBAL，
     * Agent 去扩展就会连续撞硬错误、再猜一轮（2026-09-23 本地实测 Job `e55681b7` 有 5 次），
     * 而它请求的意图其实已经满足。单调性没有被放宽 —— 关键断言仍然是"不记新的扩展事实、
     * 层级不变"，并且响应显式写明 `expanded: false`，不把空操作伪装成一次扩展。
     */
    const backwards = await post(h.broker, '/attempt/expand-analysis-scope', h.envelope({
      targetLevel: 'RELATED', reasonCode: 'DEPENDENCY_LOOKUP',
    }, 'expand_analysis_scope'))
    expect(backwards.status).toBe(200)
    expect(backwards.body).toMatchObject({
      expanded: false,
      currentLevel: 'RELATED',
      reasonCode: 'ALREADY_AT_OR_ABOVE_TARGET_LEVEL',
    })
    expect(h.expansions).toHaveLength(1)

    // 真正非法的输入仍然硬失败：目标层级不在词表里。
    const invalid = await post(h.broker, '/attempt/expand-analysis-scope', h.envelope({
      targetLevel: 'PRIMARY', reasonCode: 'DEPENDENCY_LOOKUP',
    }, 'expand_analysis_scope'))
    expect(invalid.status).toBe(422)
    expect(invalid.body.code).toBe('SCOPE_EXPANSION_INVALID')
    expect(h.expansions).toHaveLength(1)
  })

  it('把数据库侧的工具级稳定错误码原样返回，不抹成 TOOL_FAILED', async () => {
    /*
     * 真实缺口（2026-09-23 本地全链路实测 Job `e55681b7`）：Broker 的 catch 只认
     * SnapshotError，数据库抛出的 `DIFF_ACCESS_REQUIRED` /
     * `ANALYSIS_SCOPE_TRIAGE_INCOMPLETE` 等工具级门禁全部被记成 `TOOL_FAILED`，
     * 于是审计行与运行事件里"模型没读 diff 就下判定"和"工具崩了"分不开。
     */
    const repo = await repository()
    const h = await harness(repo.head, repo.gitDir, scope(repo.head), {
      submitCommitRelevanceVerdict: async () => {
        throw new DbError(
          'rpc submit_story_commit_relevance_verdict failed: DIFF_ACCESS_REQUIRED',
          'DIFF_ACCESS_REQUIRED',
        )
      },
    })

    const rejected = await post(h.broker, '/attempt/submit-commit-relevance', h.envelope({
      // 先满足 Worker 侧契约（diff 不可读 → 必须 UNCERTAIN + DIFF_UNAVAILABLE），
      // 这样请求才会真正走到数据库钩子，测的就是数据库错误码的透传。
      candidateId: CANDIDATE_ID, verdict: 'UNCERTAIN', reasonCodes: ['DIFF_UNAVAILABLE'],
      confidence: 0.4, diffAccessIds: [], summary: 'diff unavailable',
    }, 'submit_commit_relevance_verdict'))

    expect(rejected.status).toBe(422)
    expect(rejected.body.code).toBe('DIFF_ACCESS_REQUIRED')
    // 审计行与运行事件用的是 catch 里同一个 errorCode 变量，所以响应码正确即等价于
    // 审计码正确；这里不再另造一个 audit sink 去重复断言同一个赋值。
  })

  it('消息前缀形式的稳定码也要还原（内部门禁抛的是普通 Error）', async () => {
    const repo = await repository()
    // 不配置 triage 持久化钩子：submit-commit-relevance 会抛
    // `new Error('TRIAGE_PERSISTENCE_UNAVAILABLE: …')`，稳定码只存在于消息前缀里。
    const h = await harness(repo.head, repo.gitDir, scope(repo.head), {
      submitCommitRelevanceVerdict: undefined,
    })
    const rejected = await post(h.broker, '/attempt/submit-commit-relevance', h.envelope({
      candidateId: CANDIDATE_ID, verdict: 'UNCERTAIN', reasonCodes: ['DIFF_UNAVAILABLE'],
      confidence: 0.4, diffAccessIds: [], summary: 'diff unavailable',
    }, 'submit_commit_relevance_verdict'))
    expect(rejected.status).toBe(422)
    expect(rejected.body.code).toBe('TRIAGE_PERSISTENCE_UNAVAILABLE')
  })

  it('Worker 侧契约错误也带自己的稳定码（不再是匿名 TOOL_FAILED）', async () => {
    const repo = await repository()
    const h = await harness(repo.head, repo.gitDir)
    // diff 不可读却给了 RELATED：违反 Worker 侧裁定契约。
    const rejected = await post(h.broker, '/attempt/submit-commit-relevance', h.envelope({
      candidateId: CANDIDATE_ID, verdict: 'RELATED', reasonCodes: ['CODE_SEMANTIC_MATCH'],
      confidence: 0.9, diffAccessIds: [], summary: 'no diff read',
    }, 'submit_commit_relevance_verdict'))
    expect(rejected.status).toBe(422)
    expect(rejected.body.code).toBe('TRIAGE_VERDICT_REJECTED')
  })

  it('enforces frozen PRIMARY files over the real Unix socket and allows repository dependencies only after RELATED expansion', async () => {
    const repo = await repository()
    const h = await harness(repo.head, repo.gitDir)

    const beforeTriage = await post(h.broker, '/attempt/read-code', h.envelope({
      repository: 'kdmanage-backend', path: 'src/order.ts', startLine: 1, endLine: 2,
    }, 'read_snapshot_code'))
    expect(beforeTriage.status).toBe(403)

    const diff = await post(h.broker, '/attempt/read-story-commit-diff', h.envelope({
      candidateId: CANDIDATE_ID,
    }, 'read_story_commit_diff'))
    expect(diff.status).toBe(200)
    const triage = await post(h.broker, '/attempt/submit-commit-relevance', h.envelope({
      candidateId: CANDIDATE_ID, verdict: 'RELATED', reasonCodes: ['CODE_SEMANTIC_MATCH'],
      confidence: 0.9, diffAccessIds: [ACCESS_ID], summary: 'selected after current-run N/N',
    }, 'submit_commit_relevance_verdict'))
    expect(triage.status).toBe(200)

    const allowed = await post(h.broker, '/attempt/read-code', h.envelope({
      repository: 'kdmanage-backend', path: 'src/order.ts', startLine: 1, endLine: 2,
    }, 'read_snapshot_code'))
    expect(allowed.status).toBe(200)

    const denied = await post(h.broker, '/attempt/read-code', h.envelope({
      repository: 'kdmanage-backend', path: 'src/unrelated.ts', startLine: 1, endLine: 2,
    }, 'read_snapshot_code'))
    expect(denied.status).toBe(403)
    expect(denied.body.code).toBe('SNAPSHOT_SCOPE_DENIED')

    const primarySearch = await post(h.broker, '/attempt/search-code', h.envelope({
      repository: 'kdmanage-backend', query: 'OUT_OF_SCOPE_DEPENDENCY',
    }, 'search_snapshot_code'))
    expect(primarySearch.status).toBe(200)
    expect(primarySearch.body).toMatchObject({ hits: [], total: 0 })

    const primaryFind = await post(h.broker, '/attempt/find-files', h.envelope({
      repository: 'kdmanage-backend', pattern: '**/*.ts',
    }, 'find_snapshot_files'))
    expect(primaryFind.status).toBe(200)
    expect(primaryFind.body.paths).toEqual(['src/order.ts'])

    const expanded = await post(h.broker, '/attempt/expand-analysis-scope', h.envelope({
      targetLevel: 'RELATED', reasonCode: 'DEPENDENCY_LOOKUP',
    }, 'expand_analysis_scope'))
    expect(expanded.status).toBe(200)

    const relatedRead = await post(h.broker, '/attempt/read-code', h.envelope({
      repository: 'kdmanage-backend', path: 'src/unrelated.ts', startLine: 1, endLine: 2,
    }, 'read_snapshot_code'))
    expect(relatedRead.status).toBe(200)
    expect(String(relatedRead.body.content)).toContain('OUT_OF_SCOPE_DEPENDENCY')

    const relatedSearch = await post(h.broker, '/attempt/search-code', h.envelope({
      repository: 'kdmanage-backend', query: 'OUT_OF_SCOPE_DEPENDENCY',
    }, 'search_snapshot_code'))
    expect(relatedSearch.status).toBe(200)
    expect(relatedSearch.body.hits).toEqual([
      expect.objectContaining({ filePath: 'src/unrelated.ts' }),
    ])
  })

  it('fails PRIMARY closed when an older DB scope proxy omits candidate files', async () => {
    const repo = await repository()
    const withoutFiles = scope(repo.head)
    withoutFiles.triage_complete = true
    withoutFiles.triage_completed_count = 1
    withoutFiles.candidates[0]!.triage_verdict = 'RELATED'
    withoutFiles.candidates[0]!.selected = true
    withoutFiles.candidates[0]!.selection_level = 'PRIMARY'
    withoutFiles.candidates = withoutFiles.candidates.map(({ files: _files, ...candidate }) => candidate)
    const h = await harness(repo.head, repo.gitDir, withoutFiles)

    const read = await post(h.broker, '/attempt/read-code', h.envelope({
      repository: 'kdmanage-backend', path: 'src/order.ts', startLine: 1, endLine: 2,
    }, 'read_snapshot_code'))
    expect(read.status).toBe(403)
    expect(read.body.code).toBe('SNAPSHOT_SCOPE_DENIED')

    const search = await post(h.broker, '/attempt/search-code', h.envelope({
      repository: 'kdmanage-backend', query: 'line1',
    }, 'search_snapshot_code'))
    expect(search.status).toBe(200)
    expect(search.body).toMatchObject({ hits: [], total: 0 })
  })
})