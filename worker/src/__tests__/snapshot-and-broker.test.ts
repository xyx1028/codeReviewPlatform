/**
 * Snapshot store, ledgers, verifier and attempt broker against a real git
 * repository.
 *
 * These use actual commits because the property that matters cannot be faked
 * with a stub: reads must resolve against the commit object, so a modified
 * working tree must not be able to change what the model sees or what
 * verification re-reads.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from '../git/run.js'
import { SnapshotStore } from '../ai/snapshot/snapshot-store.js'
import { EvidenceLedger } from '../ai/snapshot/evidence-ledger.js'
import { SearchCoverageLedger } from '../ai/snapshot/search-coverage-ledger.js'
import { verifyReviewSubmission } from '../ai/snapshot/deterministic-verifier.js'
import { startAttemptControlBroker } from '../ai/control/attempt-control-broker.js'
import {
  AgentAuthorityLedger,
  mintRootIdentity,
} from '../ai/control/agent-authority-ledger.js'
import { HierarchicalBudgetLedger } from '../ai/control/hierarchical-budget-ledger.js'
import { V4_DEFAULT_POLICY, policyHash } from '../ai/policy/v4-capability-policy.js'
import { brokerPost } from '../harness-plugins/shared/broker-client.js'
import { Logger } from '../logger.js'

const REPO = 'kdmanage-backend'
const TASK_ID = 'task-1'
const ATTEMPT = 2

function silentLogger(): Logger {
  return new Logger({ sink: () => {}, minLevel: 'error' })
}

let gitDir: string
let commitSha: string

beforeAll(async () => {
  gitDir = mkdtempSync(join(tmpdir(), 'snap-repo-'))
  await runCommand('git', ['init', '--quiet', '--initial-branch=main'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.email', 'test@example.invalid'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.name', 'Snapshot Test'], { cwd: gitDir })

  mkdirSync(join(gitDir, 'src', 'main'), { recursive: true })
  writeFileSync(
    join(gitDir, 'src', 'main', 'OrderService.java'),
    [
      'package main;',
      '',
      'public class OrderService {',
      '  public void createOrder() {',
      '    // committed implementation',
      '  }',
      '}',
      '',
    ].join('\n'),
  )
  writeFileSync(join(gitDir, 'src', 'main', 'Unrelated.java'), 'class Unrelated {}\n')
  mkdirSync(join(gitDir, 'node_modules', 'evil'), { recursive: true })
  writeFileSync(join(gitDir, 'node_modules', 'evil', 'index.js'), 'createOrder\n')
  writeFileSync(join(gitDir, '.env'), 'SECRET_TOKEN=must-not-be-read\n')

  await runCommand('git', ['add', '--all'], { cwd: gitDir })
  await runCommand('git', ['commit', '--quiet', '-m', 'feat: add createOrder for PRJ-001'], {
    cwd: gitDir,
  })
  const head = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: gitDir })
  commitSha = head.stdout.trim()

  // Tamper with the working tree AFTER the commit. Nothing below may observe it.
  writeFileSync(
    join(gitDir, 'src', 'main', 'OrderService.java'),
    'TAMPERED WORKING TREE CONTENT\n',
  )
})

afterAll(() => {
  rmSync(gitDir, { recursive: true, force: true })
})

function store(): SnapshotStore {
  return new SnapshotStore([{ name: REPO, commitSha, gitDir }])
}

describe('SnapshotStore reads commit objects, not the working tree', () => {
  it('returns committed content even though the working file was replaced', async () => {
    const read = await store().readRange({
      repository: REPO,
      path: 'src/main/OrderService.java',
      startLine: 1,
      endLine: 20,
    })
    expect(read.content).toContain('committed implementation')
    expect(read.content).not.toContain('TAMPERED')
    expect(read.commitSha).toBe(commitSha)
    expect(read.blobSha).toMatch(/^[0-9a-f]{40}$/)
    expect(read.totalLines).toBeGreaterThan(5)
  })

  it('finds matches in the commit tree and skips blocked directories', async () => {
    const result = await store().search({ repository: REPO, query: 'createOrder' })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.every((hit) => !hit.filePath.startsWith('node_modules/'))).toBe(true)
    expect(result.hits.some((hit) => hit.filePath === 'src/main/OrderService.java')).toBe(true)
  })

  it('reports truncation instead of silently clipping a search', async () => {
    const result = await store().search({ repository: REPO, query: 'class', maxResults: 1 })
    expect(result.hits).toHaveLength(1)
    expect(result.truncated || result.total >= 1).toBe(true)
  })

  it('matches globs against tree paths', async () => {
    const result = await store().findFiles({ repository: REPO, pattern: '**/*.java' })
    expect(result.paths).toContain('src/main/OrderService.java')
    expect(result.paths).toContain('src/main/Unrelated.java')
    expect(result.paths.every((path) => !path.includes('node_modules'))).toBe(true)
  })

  it('lists commits reachable from the pin', async () => {
    const commits = await store().commits({ repository: REPO, maxResults: 10 })
    expect(commits[0]?.sha).toBe(commitSha)
    expect(commits[0]?.subject).toContain('PRJ-001')
  })

  it('refuses traversal, absolute paths, secrets and unpinned repositories', async () => {
    const snapshots = store()
    await expect(
      snapshots.readRange({ repository: REPO, path: '../outside.txt', startLine: 1, endLine: 2 }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_PATH_INVALID' })
    await expect(
      snapshots.readRange({ repository: REPO, path: '/etc/passwd', startLine: 1, endLine: 2 }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_PATH_INVALID' })
    await expect(
      snapshots.readRange({ repository: REPO, path: '.env', startLine: 1, endLine: 2 }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_PATH_BLOCKED' })
    await expect(
      snapshots.readRange({
        repository: 'tmanage-frontend',
        path: 'src/main/OrderService.java',
        startLine: 1,
        endLine: 2,
      }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_REPO_NOT_PINNED' })
    await expect(
      snapshots.readRange({ repository: REPO, path: 'src/main/Missing.java', startLine: 1, endLine: 2 }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_PATH_MISSING' })
  })

  it('fails closed when a pinned commit is not present locally', async () => {
    const bogus = new SnapshotStore([{ name: REPO, commitSha: 'b'.repeat(40), gitDir }])
    await expect(bogus.verifyPins()).rejects.toMatchObject({
      code: 'SNAPSHOT_COMMIT_MISSING',
    })
    await expect(store().verifyPins()).resolves.toBeUndefined()
  })

  it('rejects a short or non-hex commit pin outright', () => {
    expect(() => new SnapshotStore([{ name: REPO, commitSha: 'abc', gitDir }])).toThrow(
      /40-hex commit sha/,
    )
  })
})

describe('EvidenceLedger', () => {
  it('only accepts ids it issued, for the same attempt, file and range', () => {
    const ledger = new EvidenceLedger(TASK_ID, ATTEMPT)
    const receipt = ledger.record({
      repository: REPO,
      commitSha,
      filePath: 'src/main/OrderService.java',
      blobSha: 'a'.repeat(40),
      startLine: 1,
      endLine: 10,
      contentHash: 'hash',
    })

    expect(
      ledger.check({
        evidenceId: receipt.evidenceId,
        repository: REPO,
        filePath: 'src/main/OrderService.java',
        startLine: 3,
        endLine: 6,
      }).ok,
    ).toBe(true)

    const unknown = ledger.check({
      evidenceId: 'ev_made-up',
      repository: REPO,
      filePath: 'src/main/OrderService.java',
      startLine: 1,
      endLine: 2,
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.rejection.code).toBe('EVIDENCE_ID_UNKNOWN')

    const wrongFile = ledger.check({
      evidenceId: receipt.evidenceId,
      repository: REPO,
      filePath: 'src/main/Unrelated.java',
      startLine: 1,
      endLine: 2,
    })
    expect(wrongFile.ok).toBe(false)
    if (!wrongFile.ok) expect(wrongFile.rejection.code).toBe('EVIDENCE_MISMATCH')

    const outside = ledger.check({
      evidenceId: receipt.evidenceId,
      repository: REPO,
      filePath: 'src/main/OrderService.java',
      startLine: 1,
      endLine: 99,
    })
    expect(outside.ok).toBe(false)
    if (!outside.ok) expect(outside.rejection.code).toBe('EVIDENCE_RANGE_OUTSIDE')
  })

  it('rejects a receipt issued for a different attempt', () => {
    const issuing = new EvidenceLedger(TASK_ID, 1)
    const receipt = issuing.record({
      repository: REPO,
      commitSha,
      filePath: 'src/main/OrderService.java',
      blobSha: 'a'.repeat(40),
      startLine: 1,
      endLine: 5,
      contentHash: 'hash',
    })

    // A later attempt re-uses the id string; the ledger must not know it.
    const later = new EvidenceLedger(TASK_ID, 2)
    const verdict = later.check({
      evidenceId: receipt.evidenceId,
      repository: REPO,
      filePath: 'src/main/OrderService.java',
      startLine: 1,
      endLine: 5,
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.rejection.code).toBe('EVIDENCE_ID_UNKNOWN')
  })
})

describe('SearchCoverageLedger', () => {
  const policy = { requiredRepositories: [REPO] as const, minQueriesPerRepository: 2 }

  it('requires enough distinct complete searches per repository', () => {
    const ledger = new SearchCoverageLedger()
    ledger.record({ repository: REPO, query: 'createOrder', hits: 0, truncated: false })
    expect(ledger.evaluate(policy).sufficient).toBe(false)

    ledger.record({ repository: REPO, query: 'order service', hits: 0, truncated: false })
    expect(ledger.evaluate(policy).sufficient).toBe(true)
  })

  it('never counts a truncated search towards proving absence', () => {
    const ledger = new SearchCoverageLedger()
    ledger.record({ repository: REPO, query: 'a', hits: 50, truncated: true })
    ledger.record({ repository: REPO, query: 'b', hits: 50, truncated: true })
    const verdict = ledger.evaluate(policy)
    expect(verdict.sufficient).toBe(false)
    expect(verdict.truncatedSearches).toBe(2)
    expect(verdict.reason).toContain('UNCERTAIN')
  })

  it('treats repeated identical queries as one', () => {
    const ledger = new SearchCoverageLedger()
    ledger.record({ repository: REPO, query: 'Same', hits: 0, truncated: false })
    ledger.record({ repository: REPO, query: 'same', hits: 0, truncated: false })
    expect(ledger.evaluate(policy).sufficient).toBe(false)
  })
})

describe('verifyReviewSubmission', () => {
  const coveragePolicy = { requiredRepositories: [REPO] as const, minQueriesPerRepository: 1 }

  async function showRange(ledger: EvidenceLedger) {
    const snapshots = store()
    const read = await snapshots.readRange({
      repository: REPO,
      path: 'src/main/OrderService.java',
      startLine: 1,
      endLine: 10,
    })
    return ledger.record({
      repository: read.repository,
      commitSha: read.commitSha,
      filePath: read.filePath,
      blobSha: read.blobSha,
      startLine: read.startLine,
      endLine: read.endLine,
      contentHash: read.contentHash,
    })
  }

  it('accepts a submission whose evidence re-reads identically', async () => {
    const evidenceLedger = new EvidenceLedger(TASK_ID, ATTEMPT)
    const receipt = await showRange(evidenceLedger)
    const result = await verifyReviewSubmission({
      submission: {
        verdict: 'IMPLEMENTED',
        confidence: 90,
        summary: 'createOrder implements the story',
        evidence: [
          {
            evidenceId: receipt.evidenceId,
            repository: REPO,
            filePath: 'src/main/OrderService.java',
            startLine: 3,
            endLine: 6,
            evidenceType: '现有实现',
            description: 'createOrder',
          },
        ],
      },
      evidenceLedger,
      coverageLedger: new SearchCoverageLedger(),
      snapshots: store(),
      coveragePolicy,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.evidence[0]?.blobSha).toBe(receipt.blobSha)
      expect(result.evidence[0]?.commitSha).toBe(commitSha)
    }
  })

  it('refuses IMPLEMENTED without an existing-implementation evidence item', async () => {
    const evidenceLedger = new EvidenceLedger(TASK_ID, ATTEMPT)
    const receipt = await showRange(evidenceLedger)
    const result = await verifyReviewSubmission({
      submission: {
        verdict: 'IMPLEMENTED',
        confidence: 90,
        summary: 's',
        evidence: [
          {
            evidenceId: receipt.evidenceId,
            repository: REPO,
            filePath: 'src/main/OrderService.java',
            startLine: 3,
            endLine: 6,
            evidenceType: '相关代码',
            description: 'related only',
          },
        ],
      },
      evidenceLedger,
      coverageLedger: new SearchCoverageLedger(),
      snapshots: store(),
      coveragePolicy,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('EVIDENCE_IMPLEMENTATION_REQUIRED')
  })

  it('refuses NOT_IMPLEMENTED when search coverage cannot support it', async () => {
    const result = await verifyReviewSubmission({
      submission: {
        verdict: 'NOT_IMPLEMENTED',
        confidence: 80,
        summary: 'nothing found',
        evidence: [],
      },
      evidenceLedger: new EvidenceLedger(TASK_ID, ATTEMPT),
      coverageLedger: new SearchCoverageLedger(),
      snapshots: store(),
      coveragePolicy,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('COVERAGE_INSUFFICIENT')
  })

  it('allows UNCERTAIN without evidence or coverage', async () => {
    const result = await verifyReviewSubmission({
      submission: {
        verdict: 'UNCERTAIN',
        confidence: 40,
        summary: 'could not cover the repositories',
        evidence: [],
      },
      evidenceLedger: new EvidenceLedger(TASK_ID, ATTEMPT),
      coverageLedger: new SearchCoverageLedger(),
      snapshots: store(),
      coveragePolicy,
    })
    expect(result.ok).toBe(true)
  })

  it('rejects an out-of-range confidence and an invalid verdict', async () => {
    const base = {
      evidenceLedger: new EvidenceLedger(TASK_ID, ATTEMPT),
      coverageLedger: new SearchCoverageLedger(),
      snapshots: store(),
      coveragePolicy,
    }
    const badConfidence = await verifyReviewSubmission({
      ...base,
      submission: { verdict: 'UNCERTAIN', confidence: 140, summary: 's', evidence: [] },
    })
    expect(badConfidence.ok).toBe(false)

    const badVerdict = await verifyReviewSubmission({
      ...base,
      submission: {
        verdict: 'MAYBE' as never,
        confidence: 50,
        summary: 's',
        evidence: [],
      },
    })
    expect(badVerdict.ok).toBe(false)
    if (!badVerdict.ok) expect(badVerdict.code).toBe('VERDICT_INVALID')
  })
})

describe('AttemptControlBroker', () => {
  /** 本次 attempt 的根身份。V4 里每个 Broker 请求都必须出示它，否则 403。 */
  interface RootIdentity {
    agentCapability: string
    agentId: string
    sessionId: string
  }

  async function withBroker(
    overrides: {
      isLeaseValid?: () => boolean
      commitReview?: (input: unknown) => Promise<{ runId: string; committedAt: string }>
    },
    body: (
      handle: Awaited<ReturnType<typeof startAttemptControlBroker>>,
      identity: RootIdentity,
    ) => Promise<void>,
  ) {
    const socketRoot = mkdtempSync(join(tmpdir(), 'brk-'))
    let commits = 0
    // V4：Broker 不再只认 attempt token；它按 agent capability 查身份。根身份由 Worker 生成
    // （mintRootIdentity），预算裁决走跨进程账本（HierarchicalBudgetLedger）。
    const { rootAgentId, rootSessionId } = mintRootIdentity(TASK_ID, ATTEMPT)
    const authority = new AgentAuthorityLedger({
      taskId: TASK_ID,
      agentAttempt: ATTEMPT,
      policy: V4_DEFAULT_POLICY,
      rootAgentId,
      rootSessionId,
    })
    const budget = new HierarchicalBudgetLedger({ policy: V4_DEFAULT_POLICY })
    const handle = await startAttemptControlBroker({
      taskId: TASK_ID,
      agentAttempt: ATTEMPT,
      snapshots: store(),
      coveragePolicy: { requiredRepositories: [REPO], minQueriesPerRepository: 1 },
      socketRoot,
      logger: silentLogger(),
      policy: V4_DEFAULT_POLICY,
      policyHash: policyHash(V4_DEFAULT_POLICY),
      authority,
      budget,
      isLeaseValid: overrides.isLeaseValid ?? (() => true),
      commitReview:
        overrides.commitReview ??
        (async () => {
          commits++
          return { runId: `run-${commits}`, committedAt: '2026-01-01T00:00:00.000Z' }
        }),
    })
    // root capability token 只交给子进程的 patch，从不进日志；测试里由 ledger 直接取用。
    const identity: RootIdentity = {
      agentCapability: authority.rootCapabilityToken,
      agentId: rootAgentId,
      sessionId: rootSessionId,
    }
    try {
      await body(handle, identity)
    } finally {
      await handle.close()
      rmSync(socketRoot, { recursive: true, force: true })
    }
  }

  /** attempt 定位字段 + 根 agent 身份，一起构成一个合法请求体的前缀。 */
  const attemptOf = (identity: RootIdentity) => ({
    taskId: TASK_ID,
    agentAttempt: ATTEMPT,
    ...identity,
  })

  it('rejects a wrong token without doing any work', async () => {
    await withBroker({}, async (handle, identity) => {
      const res = await brokerPost<{ code?: string }>(
        { socketPath: handle.socketPath, token: 'wrong-token' },
        '/attempt/read-code',
        { ...attemptOf(identity), repository: REPO, path: 'src/main/OrderService.java', startLine: 1, endLine: 5 },
      )
      expect(res.status).toBe(401)
      expect(handle.usage().evidenceShown).toBe(0)
    })
  })

  it('rejects a request naming a different task attempt', async () => {
    await withBroker({}, async (handle, identity) => {
      const res = await brokerPost<{ code?: string }>(
        { socketPath: handle.socketPath, token: handle.token },
        '/attempt/read-code',
        { ...identity, taskId: TASK_ID, agentAttempt: 99, repository: REPO, path: 'x', startLine: 1, endLine: 2 },
      )
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('ATTEMPT_MISMATCH')
    })
  })

  it('refuses every call once the lease is gone', async () => {
    await withBroker({ isLeaseValid: () => false }, async (handle, identity) => {
      const res = await brokerPost<{ code?: string }>(
        { socketPath: handle.socketPath, token: handle.token },
        '/attempt/search-code',
        { ...attemptOf(identity), repository: REPO, query: 'createOrder' },
      )
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('TASK_LEASE_LOST')
    })
  })

  it('refuses every call after revoke', async () => {
    await withBroker({}, async (handle, identity) => {
      handle.revoke('cancelled for test')
      const res = await brokerPost<{ code?: string }>(
        { socketPath: handle.socketPath, token: handle.token },
        '/attempt/search-code',
        { ...attemptOf(identity), repository: REPO, query: 'createOrder' },
      )
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('ATTEMPT_REVOKED')
    })
  })

  it('rejects a model request that carries no agent capability', async () => {
    // V4：attempt token 证明"是本次子进程"，agent capability 证明"是树里某个已注册节点"。
    // 缺 capability 的请求即使 attempt/lease 都对，也必须以 403 AGENT_IDENTITY_INVALID 挡下 ——
    // 否则子 Agent 伪造 root id 直接请求 Broker 就能得逞。
    await withBroker({}, async (handle) => {
      const res = await brokerPost<{ code?: string }>(
        { socketPath: handle.socketPath, token: handle.token },
        '/attempt/read-code',
        {
          taskId: TASK_ID,
          agentAttempt: ATTEMPT,
          repository: REPO,
          path: 'src/main/OrderService.java',
          startLine: 1,
          endLine: 5,
        },
      )
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('AGENT_IDENTITY_INVALID')
      expect(handle.usage().evidenceShown).toBe(0)
    })
  })

  it('issues evidence ids on read and never leaks blob ids to the caller', async () => {
    await withBroker({}, async (handle, identity) => {
      const res = await brokerPost<Record<string, unknown>>(
        { socketPath: handle.socketPath, token: handle.token },
        '/attempt/read-code',
        {
          ...attemptOf(identity),
          repository: REPO,
          path: 'src/main/OrderService.java',
          startLine: 1,
          endLine: 10,
        },
      )
      expect(res.status).toBe(200)
      expect(String(res.body.evidenceId)).toMatch(/^ev_/)
      expect(res.body.blobSha).toBeUndefined()
      expect(res.body.contentHash).toBeUndefined()
      expect(String(res.body.content)).toContain('committed implementation')
      expect(handle.usage().evidenceShown).toBe(1)
    })
  })

  it('returns a tool error the model can act on for a blocked path', async () => {
    await withBroker({}, async (handle, identity) => {
      const res = await brokerPost<{ code?: string; reason?: string }>(
        { socketPath: handle.socketPath, token: handle.token },
        '/attempt/read-code',
        { ...attemptOf(identity), repository: REPO, path: '.env', startLine: 1, endLine: 2 },
      )
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('SNAPSHOT_PATH_BLOCKED')
    })
  })

  it('rejects an unverifiable submission, then commits the corrected one once', async () => {
    await withBroker({}, async (handle, identity) => {
      const read = await brokerPost<{ evidenceId: string }>(
        { socketPath: handle.socketPath, token: handle.token },
        '/attempt/read-code',
        {
          ...attemptOf(identity),
          repository: REPO,
          path: 'src/main/OrderService.java',
          startLine: 1,
          endLine: 10,
        },
      )

      const bad = await brokerPost<{ accepted: boolean; code?: string }>(
        { socketPath: handle.socketPath, token: handle.token },
        '/attempt/submit-review',
        {
          ...attemptOf(identity),
          submission: {
            verdict: 'IMPLEMENTED',
            confidence: 90,
            summary: 's',
            evidence: [
              {
                evidenceId: 'ev_fabricated',
                repository: REPO,
                filePath: 'src/main/OrderService.java',
                startLine: 1,
                endLine: 5,
                evidenceType: '现有实现',
                description: 'd',
              },
            ],
          },
        },
      )
      expect(bad.body.accepted).toBe(false)
      expect(bad.body.code).toBe('EVIDENCE_ID_UNKNOWN')
      expect(handle.committed()).toBeNull()

      const good = await brokerPost<{ accepted: boolean; runId: string }>(
        { socketPath: handle.socketPath, token: handle.token },
        '/attempt/submit-review',
        {
          ...attemptOf(identity),
          submission: {
            verdict: 'IMPLEMENTED',
            confidence: 90,
            summary: 's',
            evidence: [
              {
                evidenceId: read.body.evidenceId,
                repository: REPO,
                filePath: 'src/main/OrderService.java',
                startLine: 3,
                endLine: 6,
                evidenceType: '现有实现',
                description: 'createOrder',
              },
            ],
          },
        },
      )
      expect(good.body.accepted).toBe(true)
      expect(good.body.runId).toBe('run-1')

      // A duplicate submission must not create a second result.
      const again = await brokerPost<{ accepted: boolean; runId: string }>(
        { socketPath: handle.socketPath, token: handle.token },
        '/attempt/submit-review',
        { ...attemptOf(identity), submission: { verdict: 'UNCERTAIN', confidence: 1, summary: 'x', evidence: [] } },
      )
      expect(again.body.accepted).toBe(true)
      expect(again.body.runId).toBe('run-1')
      expect(handle.committed()?.runId).toBe('run-1')
    })
  })

  it('breaks tool calls down by name and records every submission rejection', async () => {
    // 预算打满时必须能区分"花在检索阅读"和"花在反复提交被拒"，只看总次数看不出来。
    await withBroker({}, async (handle, identity) => {
      const call = (route: string, body: Record<string, unknown>) =>
        brokerPost<Record<string, unknown>>(
          { socketPath: handle.socketPath, token: handle.token },
          route,
          { ...attemptOf(identity), ...body },
        )

      await call('/attempt/search-code', { repository: REPO, query: 'alpha' })
      await call('/attempt/search-code', { repository: REPO, query: 'beta' })
      await call('/attempt/find-files', { repository: REPO, glob: '**/*.ts' })

      // 伪造的 evidenceId 必须被拒，并被计入拒绝序列。
      const rejected = await call('/attempt/submit-review', {
        submission: {
          verdict: 'IMPLEMENTED',
          confidence: 90,
          summary: 'x',
          evidence: [
            {
              evidenceId: 'ev-does-not-exist',
              repository: REPO,
              filePath: 'a.ts',
              startLine: 1,
              endLine: 2,
              evidenceType: '现有实现',
              description: 'd',
            },
          ],
        },
      })
      expect(rejected.body.accepted).toBe(false)

      const usage = handle.usage()
      expect(usage.toolCallsByName.search_snapshot_code).toBe(2)
      expect(usage.toolCallsByName.find_snapshot_files).toBe(1)
      expect(usage.toolCallsByName.submit_review_result).toBe(1)
      expect(usage.toolCalls).toBe(4)
      expect(usage.rejectedSubmissions).toHaveLength(1)
      expect(usage.rejectedSubmissions[0]).toMatch(/EVIDENCE/)

      // 快照式返回：调用方拿到的副本不能被后续调用改写。
      const before = handle.usage()
      await call('/attempt/search-code', { repository: REPO, query: 'gamma' })
      expect(before.toolCallsByName.search_snapshot_code).toBe(2)
      expect(handle.usage().toolCallsByName.search_snapshot_code).toBe(3)
    })
  })

  it('records searches so a NOT_IMPLEMENTED verdict can be earned', async () => {
    await withBroker({}, async (handle, identity) => {
      const search = await brokerPost<{ hits: unknown[] }>(
        { socketPath: handle.socketPath, token: handle.token },
        '/attempt/search-code',
        { ...attemptOf(identity), repository: REPO, query: 'somethingAbsent' },
      )
      expect(search.status).toBe(200)
      expect(search.body.hits).toEqual([])
      expect(handle.usage().searchesRun).toBe(1)

      const submitted = await brokerPost<{ accepted: boolean }>(
        { socketPath: handle.socketPath, token: handle.token },
        '/attempt/submit-review',
        {
          ...attemptOf(identity),
          submission: {
            verdict: 'NOT_IMPLEMENTED',
            confidence: 85,
            summary: 'no implementation found',
            evidence: [],
          },
        },
      )
      expect(submitted.body.accepted).toBe(true)
    })
  })
})
