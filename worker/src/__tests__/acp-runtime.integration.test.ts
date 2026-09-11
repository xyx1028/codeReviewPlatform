/**
 * Real-process POC for the Harness ACP runtime.
 *
 * This test boots the actual `dsh` launcher with the hardened profile, speaks
 * ACP over the child's stdio, and drives it with a mock OpenAI-compatible
 * endpoint. It proves the properties the design depends on and that cannot be
 * checked with unit tests:
 *
 *  1. the generated profile and per-attempt overlay boot,
 *  2. `submit_review_result` is registered as a profile-local tool,
 *  3. a rejected submission is model-correctable and does NOT end the turn,
 *  4. an accepted submission ends the turn through `concludeTurn()`,
 *  5. no session log or repository content is written to disk,
 *  6. the child process is reclaimed.
 *
 * It is opt-in because it spawns processes and needs `npm run worker:build`
 * first: RUN_ACP_INTEGRATION=1 npm run test:worker
 */

import { describe, it, expect } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSingleAcpTurn } from '../ai/acp/acp-client.js'
import { startAcpProcess } from '../ai/acp/acp-process-supervisor.js'
import { materializeAttemptProfile } from '../ai/acp/profile-materializer.js'
import { DeepSeekHarnessAcpEngine } from '../ai/runtime/deepseek-harness-acp-engine.js'
import { SnapshotStore } from '../ai/snapshot/snapshot-store.js'
import type { CommitReviewInput } from '../ai/control/attempt-control-broker.js'
import { runCommand } from '../git/run.js'
import { Logger } from '../logger.js'

const ENABLED = process.env.RUN_ACP_INTEGRATION === '1'

interface ScriptedToolCall {
  name: string
  args: unknown
}

/** A scripted turn may depend on what the conversation has revealed so far. */
type ScriptedTurn = ScriptedToolCall | ((requestBody: string) => ScriptedToolCall)

/** Minimal OpenAI-compatible streaming endpoint with scripted turns. */
function startMockModelServer(script: ScriptedTurn[]): Promise<{
  baseUrl: string
  requestCount: () => number
  close: () => Promise<void>
}> {
  let requestCount = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404).end('{}')
        return
      }
      const index = requestCount++
      const entry = script[Math.min(index, script.length - 1)]
      const scripted =
        typeof entry === 'function' ? entry(Buffer.concat(chunks).toString('utf8')) : entry
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const base = {
        id: `chatcmpl-${index}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'poc-model',
      }
      const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

      send({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${index}`,
                  type: 'function',
                  function: {
                    name: scripted.name,
                    arguments: JSON.stringify(scripted.args),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      send({
        ...base,
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveServer({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requestCount: () => requestCount,
        close: () => closeServer(server),
      })
    })
  })
}

interface BrokerCall {
  taskId: string
  agentAttempt: number
  submission: { verdict?: string; evidence?: unknown[] }
}

/** Attempt broker stand-in: rejects the first submission, accepts the second. */
function startMockBroker(socketPath: string, expectedToken: string): Promise<{
  calls: BrokerCall[]
  unauthorized: () => number
  close: () => Promise<void>
}> {
  const calls: BrokerCall[] = []
  let unauthorized = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${expectedToken}`) {
        unauthorized++
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ accepted: false, reason: 'unauthorized' }))
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as BrokerCall
      calls.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (calls.length === 1) {
        res.end(
          JSON.stringify({
            accepted: false,
            code: 'EVIDENCE_UNVERIFIED',
            reason:
              'evidence item 1 references evidenceId "made-up-id", which was never returned by a snapshot tool. Re-read the range and submit the id you were given.',
          }),
        )
        return
      }
      res.end(
        JSON.stringify({
          accepted: true,
          runId: 'run-poc-1',
          committedAt: new Date().toISOString(),
        }),
      )
    })
  })

  return new Promise((resolveServer) => {
    server.listen(socketPath, () => {
      resolveServer({ calls, unauthorized: () => unauthorized, close: () => closeServer(server) })
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

/** Recursively collect files that look like a persisted session log. */
function findSessionArtifacts(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        walk(full)
      } else if (entry.endsWith('.jsonl')) {
        found.push(full)
      }
    }
  }
  walk(root)
  return found
}

const VALID_EVIDENCE = [
  {
    evidenceId: 'ev-1',
    repository: 'kdmanage-backend',
    filePath: 'src/A.java',
    startLine: 1,
    endLine: 5,
    evidenceType: '现有实现',
    description: 'implements the story',
  },
]

describe.skipIf(!ENABLED)('ACP runtime POC (real dsh process)', () => {
  it(
    'corrects a rejected submission and ends the turn only after a committed one',
    async () => {
      const socketDir = mkdtempSync(join(tmpdir(), 'acp-b-'))
      const socketPath = join(socketDir, 's.sock')
      const cwd = mkdtempSync(join(tmpdir(), 'acp-cwd-'))
      const attemptsRoot = mkdtempSync(join(tmpdir(), 'acp-att-'))
      const token = 'poc-claim-token'

      const model = await startMockModelServer([
        {
          name: 'submit_review_result',
          args: {
            verdict: 'IMPLEMENTED',
            confidence: 90,
            summary: 'first attempt with unverifiable evidence',
            evidence: [{ ...VALID_EVIDENCE[0], evidenceId: 'made-up-id' }],
          },
        },
        {
          name: 'submit_review_result',
          args: {
            verdict: 'IMPLEMENTED',
            confidence: 90,
            summary: 'corrected submission',
            evidence: VALID_EVIDENCE,
          },
        },
      ])
      const broker = await startMockBroker(socketPath, token)

      const profile = materializeAttemptProfile({
        taskId: 'poc-task',
        agentAttempt: 1,
        attemptsRoot,
        route: {
          providerId: 'review-route',
          displayName: 'Review Route',
          baseUrl: model.baseUrl,
          modelName: 'poc-model',
          contextWindow: 131072,
          maxTokens: 4096,
          apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
          requestTimeoutMs: 60000,
        },
        budgets: {
          maxTotalRequests: 10,
          maxLoopRequests: 8,
          maxRetryRequests: 1,
          maxCompactionRequests: 1,
        },
        broker: { socketPath, token },
      })

      const child = startAcpProcess({
        dshHome: profile.dshHome,
        profileName: profile.profileName,
        patchPath: profile.patchPath,
        cwd,
        apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
        apiKey: 'poc-not-a-real-key',
        killGraceMs: 3000,
      })

      const controller = new AbortController()
      try {
        const turn = await runSingleAcpTurn(
          { process: child, cwd },
          'Review story PRJ-001 and submit the result.',
          controller.signal,
        )

        // The turn ended because the tool concluded it, not because it failed.
        expect(turn.stopReason, `stderr: ${child.stderr()}`).toBe('end_turn')
        expect(turn.toolNames).toContain('submit_review_result')

        // One rejected submission, then one accepted: the model corrected itself
        // inside the same session.
        expect(broker.calls).toHaveLength(2)
        expect(broker.unauthorized()).toBe(0)
        expect(broker.calls[0]?.taskId).toBe('poc-task')
        expect(broker.calls[0]?.agentAttempt).toBe(1)
        const evidenceIdOf = (call: BrokerCall | undefined): unknown =>
          (call?.submission.evidence?.[0] as { evidenceId?: unknown } | undefined)?.evidenceId
        expect(evidenceIdOf(broker.calls[0])).toBe('made-up-id')
        expect(evidenceIdOf(broker.calls[1])).toBe('ev-1')

        // Two model requests: the first turn plus the correction turn.
        expect(model.requestCount()).toBeGreaterThanOrEqual(2)

        // Nothing was persisted: tool results carry source code.
        expect(findSessionArtifacts(profile.dshHome)).toEqual([])
      } finally {
        controller.abort()
        const exit = await child.terminate()
        expect(exit.signal === 'SIGKILL').toBe(false)
        await broker.close()
        await model.close()
        profile.cleanup()
        rmSync(socketDir, { recursive: true, force: true })
        rmSync(cwd, { recursive: true, force: true })
        rmSync(attemptsRoot, { recursive: true, force: true })
      }
    },
    180000,
  )
})

/** Build a one-commit repository and return its exact commit id. */
async function buildSnapshotRepo(): Promise<{ gitDir: string; commitSha: string }> {
  const gitDir = mkdtempSync(join(tmpdir(), 'acp-repo-'))
  await runCommand('git', ['init', '--quiet', '--initial-branch=main'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.email', 'test@example.invalid'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.name', 'ACP Test'], { cwd: gitDir })
  mkdirSync(join(gitDir, 'src'), { recursive: true })
  writeFileSync(
    join(gitDir, 'src', 'OrderService.java'),
    [
      'package main;',
      '',
      'public class OrderService {',
      '  public void createOrder() {',
      '    // implements PRJ-001',
      '  }',
      '}',
      '',
    ].join('\n'),
  )
  await runCommand('git', ['add', '--all'], { cwd: gitDir })
  await runCommand('git', ['commit', '--quiet', '-m', 'feat: createOrder for PRJ-001'], {
    cwd: gitDir,
  })
  const head = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: gitDir })
  return { gitDir, commitSha: head.stdout.trim() }
}

const EVIDENCE_ID_PATTERN = /ev_[0-9a-f-]{36}/

describe.skipIf(!ENABLED)('DeepSeekHarnessAcpEngine (real dsh process, real snapshot)', () => {
  it(
    'searches, reads, is refused for fabricated evidence, then commits a verified result',
    async () => {
      const { gitDir, commitSha } = await buildSnapshotRepo()
      const attemptsRoot = mkdtempSync(join(tmpdir(), 'acp-eng-'))
      const repository = 'kdmanage-backend'

      // The submission turn needs the evidenceId the read tool handed out, so
      // the last two turns are derived from the conversation itself.
      const submission = (evidenceId: string, summary: string) => ({
        name: 'submit_review_result',
        args: {
          verdict: 'IMPLEMENTED',
          confidence: 92,
          summary,
          implementedContent: 'OrderService.createOrder implements the story',
          evidence: [
            {
              evidenceId,
              repository,
              filePath: 'src/OrderService.java',
              startLine: 3,
              endLine: 6,
              evidenceType: '现有实现',
              description: 'createOrder',
            },
          ],
        },
      })

      const model = await startMockModelServer([
        { name: 'search_snapshot_code', args: { repository, query: 'createOrder' } },
        {
          name: 'read_snapshot_code',
          args: { repository, path: 'src/OrderService.java', startLine: 1, endLine: 20 },
        },
        // Fabricated id: the broker must refuse this without committing.
        submission('ev_00000000-0000-4000-8000-000000000000', 'fabricated evidence'),
        (body) => {
          const found = body.match(EVIDENCE_ID_PATTERN)
          return submission(found?.[0] ?? 'ev_still-missing', 'corrected evidence')
        },
      ])

      const commits: CommitReviewInput[] = []
      const engine = new DeepSeekHarnessAcpEngine({
        taskId: 'engine-task',
        agentAttempt: 1,
        branch: 'feature_dev',
        story: {
          code: 'PRJ-001',
          name: '下单接口',
          description: '实现 createOrder 下单接口。',
          acceptanceCriteria: '可以创建订单。',
        },
        snapshots: new SnapshotStore([{ name: repository, commitSha, gitDir }]),
        route: {
          providerId: 'review-route',
          displayName: 'Review Route',
          baseUrl: model.baseUrl,
          modelName: 'poc-model',
          contextWindow: 131072,
          maxTokens: 4096,
          apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
          requestTimeoutMs: 60000,
        },
        budgets: {
          maxTotalRequests: 20,
          maxLoopRequests: 16,
          maxRetryRequests: 2,
          maxCompactionRequests: 2,
        },
        coveragePolicy: { requiredRepositories: [repository], minQueriesPerRepository: 1 },
        apiKey: 'engine-not-a-real-key',
        attemptsRoot,
        logger: new Logger({ sink: () => {}, minLevel: 'error' }),
        isLeaseValid: () => true,
        commitReview: async (input) => {
          commits.push(input)
          return { runId: 'run-engine-1', committedAt: new Date().toISOString() }
        },
      })

      try {
        const result = await engine.runReview({
          signal: new AbortController().signal,
          logger: new Logger({ sink: () => {}, minLevel: 'error' }),
        })

        expect(result.ok, `engine failed: ${result.errorCode} ${result.errorMessage}`).toBe(true)
        expect(result.taskId).toBe('engine-task')
        expect(result.storyCode).toBe('PRJ-001')

        // Exactly one commit: the fabricated submission was refused.
        expect(commits).toHaveLength(1)
        const committed = commits[0]
        expect(committed?.submission.verdict).toBe('IMPLEMENTED')
        expect(committed?.submission.summary).toBe('corrected evidence')

        // The stored evidence is what the platform verified, not what the model
        // asserted: it carries the commit and blob it was re-read from.
        expect(committed?.evidence).toHaveLength(1)
        expect(committed?.evidence[0]?.commitSha).toBe(commitSha)
        expect(committed?.evidence[0]?.blobSha).toMatch(/^[0-9a-f]{40}$/)
        expect(committed?.evidence[0]?.filePath).toBe('src/OrderService.java')
        expect(committed?.evidence[0]?.evidenceType).toBe('现有实现')

        // Search, read, two submissions.
        expect(committed?.usage.searchesRun).toBeGreaterThanOrEqual(1)
        expect(committed?.usage.evidenceShown).toBeGreaterThanOrEqual(1)
        expect(model.requestCount()).toBeGreaterThanOrEqual(4)
      } finally {
        await model.close()
        rmSync(attemptsRoot, { recursive: true, force: true })
        rmSync(gitDir, { recursive: true, force: true })
      }
    },
    180000,
  )
})
