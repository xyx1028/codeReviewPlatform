/**
 * The worker-side control plane for one review attempt.
 *
 * Everything privileged stays on this side of the socket: the snapshot roots,
 * the database credentials, the evidence ledger and the commit decision. The
 * Harness child process and its MCP bridge hold only a socket path and a
 * per-attempt token, so compromising them cannot reach the database, the model
 * key, or any repository outside the pinned commits.
 *
 * Transport is a Unix domain socket inside a 0700 directory. Every request must
 * present the attempt token, name this task and this agent attempt, and arrive
 * while the lease is still held.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import type { Logger } from '../../logger.js'
import { redactError } from '../../security/redaction.js'
import type { RepositoryName } from '../../git/repositories.js'
import { SnapshotError } from '../snapshot/git-object-reader.js'
import type { SnapshotStore } from '../snapshot/snapshot-store.js'
import { EvidenceLedger } from '../snapshot/evidence-ledger.js'
import { SearchCoverageLedger } from '../snapshot/search-coverage-ledger.js'
import {
  verifyReviewSubmission,
  type ReviewSubmission,
  type VerifiedEvidence,
} from '../snapshot/deterministic-verifier.js'
import type { CoveragePolicy } from '../snapshot/search-coverage-ledger.js'

export interface CommitReviewInput {
  submission: ReviewSubmission
  evidence: VerifiedEvidence[]
  usage: BrokerUsageSnapshot
  /**
   * Hash of the resolved Harness configuration for this attempt. Recorded with
   * the run so a result can be traced back to the exact profile that produced
   * it. Absent until the profile has been materialized.
   */
  configHash: string | null
}

export interface CommitReviewResult {
  runId: string
  committedAt: string
}

export interface BrokerUsageSnapshot {
  modelRequests: number
  retryRequests: number
  compactionRequests: number
  toolCalls: number
  evidenceShown: number
  searchesRun: number
  /**
   * 每个工具各被调用了多少次，以及提交被拒的错误码序列。
   *
   * 这两项是回答"一次 attempt 的预算花在哪"的关键：预算打满时，需要区分
   * "都花在检索阅读上"和"都花在反复提交被拒上"。后者是 prompt 要求模型
   * 修正后重试造成的，只看总次数看不出来。
   */
  toolCallsByName: Record<string, number>
  rejectedSubmissions: string[]
}

export interface AttemptControlBrokerOptions {
  taskId: string
  agentAttempt: number
  snapshots: SnapshotStore
  coveragePolicy: CoveragePolicy
  /** Root directory that will hold the per-attempt socket. */
  socketRoot: string
  logger: Logger
  /**
   * Persist a verified review atomically. Returning a receipt is what allows
   * the terminal tool to conclude the agent's turn; throwing keeps the attempt
   * running and surfaces a non-correctable failure.
   */
  commitReview(input: CommitReviewInput): Promise<CommitReviewResult>
  /** True while this worker still holds the task lease. */
  isLeaseValid(): boolean
}

export interface AttemptControlHandle {
  socketPath: string
  token: string
  usage(): BrokerUsageSnapshot
  committed(): CommitReviewResult | null
  /**
   * Record the resolved profile hash once the attempt's profile exists. The
   * broker must be listening before the profile is materialized (the profile
   * needs the socket path), so the hash arrives afterwards.
   */
  setConfigHash(hash: string): void
  /** Reject every further request; used on lease loss and teardown. */
  revoke(reason: string): void
  close(): Promise<void>
}

interface AttemptEnvelope {
  taskId?: unknown
  agentAttempt?: unknown
}

export function startAttemptControlBroker(
  options: AttemptControlBrokerOptions,
): Promise<AttemptControlHandle> {
  const token = randomUUID()
  const evidenceLedger = new EvidenceLedger(options.taskId, options.agentAttempt)
  const coverageLedger = new SearchCoverageLedger()

  mkdirSync(options.socketRoot, { recursive: true, mode: 0o700 })
  chmodSync(options.socketRoot, 0o700)
  // Short random name: a Unix socket path has a hard length limit.
  const socketPath = join(options.socketRoot, `${randomUUID().slice(0, 8)}.sock`)

  let revokedReason: string | null = null
  let committed: CommitReviewResult | null = null
  let toolCalls = 0
  let configHash: string | null = null
  const toolCallsByName: Record<string, number> = {}
  const rejectedSubmissions: string[] = []

  const usage = (): BrokerUsageSnapshot => ({
    modelRequests: 0,
    retryRequests: 0,
    compactionRequests: 0,
    toolCalls,
    evidenceShown: evidenceLedger.size(),
    searchesRun: coverageLedger.size(),
    toolCallsByName: { ...toolCallsByName },
    rejectedSubmissions: [...rejectedSubmissions],
  })

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      options.logger.error('broker_request_failed', {
        event: 'broker_request_failed',
        error_message: redactError(err),
      })
      respond(res, 500, { accepted: false, code: 'BROKER_INTERNAL', reason: 'broker failure' })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req)

    if (!isAuthorized(req, token)) {
      respond(res, 401, { accepted: false, code: 'BROKER_UNAUTHORIZED', reason: 'unauthorized' })
      return
    }
    if (revokedReason) {
      respond(res, 409, {
        accepted: false,
        code: 'ATTEMPT_REVOKED',
        reason: revokedReason,
      })
      return
    }
    if (!options.isLeaseValid()) {
      revokedReason = 'the task lease is no longer held by this worker'
      respond(res, 409, { accepted: false, code: 'TASK_LEASE_LOST', reason: revokedReason })
      return
    }
    if (!matchesAttempt(body, options)) {
      respond(res, 403, {
        accepted: false,
        code: 'ATTEMPT_MISMATCH',
        reason: 'request does not name this task attempt',
      })
      return
    }

    toolCalls++
    const route = req.url ?? ''
    // 按路由分桶：总次数看不出预算是花在检索还是花在反复提交上。
    const bucket = route.replace(/^\/attempt\//, '') || 'unknown'
    toolCallsByName[bucket] = (toolCallsByName[bucket] ?? 0) + 1
    try {
      switch (route) {
        case '/attempt/search-code':
          respond(res, 200, await searchCode(body))
          return
        case '/attempt/find-files':
          respond(res, 200, await options.snapshots.findFiles(body as never))
          return
        case '/attempt/read-code':
          respond(res, 200, await readCode(body))
          return
        case '/attempt/list-commits':
          respond(res, 200, { commits: await options.snapshots.commits(body as never) })
          return
        case '/attempt/snapshot-pins':
          respond(res, 200, { pins: options.snapshots.pins() })
          return
        case '/attempt/submit-review':
          respond(res, 200, await submitReview(body))
          return
        default:
          respond(res, 404, {
            accepted: false,
            code: 'BROKER_UNKNOWN_ROUTE',
            reason: `unknown route: ${route}`,
          })
          return
      }
    } catch (err) {
      // Tool-level faults are returned to the model so it can adapt; they are
      // not attempt-fatal.
      const code = err instanceof SnapshotError ? err.code : 'TOOL_FAILED'
      respond(res, 422, {
        accepted: false,
        code,
        reason: (err as Error)?.message ?? 'tool failed',
      })
    }
  }

  async function searchCode(body: Record<string, unknown>): Promise<unknown> {
    const result = await options.snapshots.search(body as never)
    coverageLedger.record({
      repository: body.repository as RepositoryName,
      query: String(body.query ?? ''),
      pathGlob: typeof body.pathGlob === 'string' ? body.pathGlob : undefined,
      hits: result.hits.length,
      truncated: result.truncated,
    })
    return result
  }

  async function readCode(body: Record<string, unknown>): Promise<unknown> {
    const read = await options.snapshots.readRange(body as never)
    const receipt = evidenceLedger.record({
      repository: read.repository,
      commitSha: read.commitSha,
      filePath: read.filePath,
      blobSha: read.blobSha,
      startLine: read.startLine,
      endLine: read.endLine,
      contentHash: read.contentHash,
    })
    // The model never sees blob ids or hashes; it only needs the citable id.
    return {
      evidenceId: receipt.evidenceId,
      repository: read.repository,
      filePath: read.filePath,
      startLine: read.startLine,
      endLine: read.endLine,
      totalLines: read.totalLines,
      truncated: read.truncated,
      content: read.content,
    }
  }

  async function submitReview(body: Record<string, unknown>): Promise<unknown> {
    if (committed) {
      // Idempotent: a retried submission must not create a second result.
      return { accepted: true, runId: committed.runId, committedAt: committed.committedAt }
    }

    const submission = body.submission as ReviewSubmission | undefined
    if (!submission || typeof submission !== 'object') {
      return { accepted: false, code: 'SUBMISSION_INVALID', reason: 'submission is required' }
    }

    const verification = await verifyReviewSubmission({
      submission,
      evidenceLedger,
      coverageLedger,
      snapshots: options.snapshots,
      coveragePolicy: options.coveragePolicy,
    })
    if (!verification.ok) {
      rejectedSubmissions.push(verification.code)
      options.logger.info('review_submission_rejected', {
        event: 'review_submission_rejected',
        error_code: verification.code,
        // 拒绝原因要带出来：模型只有看懂原因才能一次改对，反复猜就是在烧预算。
        reason: verification.reason,
        rejected_so_far: rejectedSubmissions.length,
      })
      return { accepted: false, code: verification.code, reason: verification.reason }
    }

    const receipt = await options.commitReview({
      submission,
      evidence: verification.evidence,
      usage: usage(),
      configHash,
    })
    committed = receipt
    options.logger.info('review_submission_committed', {
      event: 'review_submission_committed',
      evidence_count: verification.evidence.length,
    })
    return { accepted: true, runId: receipt.runId, committedAt: receipt.committedAt }
  }

  return new Promise<AttemptControlHandle>((resolveHandle, rejectHandle) => {
    server.once('error', rejectHandle)
    server.listen(socketPath, () => {
      server.removeListener('error', rejectHandle)
      try {
        chmodSync(socketPath, 0o600)
      } catch {
        // Some platforms do not allow chmod on sockets; the 0700 directory is
        // the primary control.
      }
      resolveHandle({
        socketPath,
        token,
        usage,
        committed: () => committed,
        setConfigHash: (hash: string) => {
          configHash = hash
        },
        revoke: (reason: string) => {
          revokedReason = reason
        },
        close: async () => {
          revokedReason = revokedReason ?? 'attempt finished'
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
          rmSync(socketPath, { force: true })
        },
      })
    })
  })
}

function matchesAttempt(
  body: Record<string, unknown>,
  options: AttemptControlBrokerOptions,
): boolean {
  const envelope = body as AttemptEnvelope
  return (
    envelope.taskId === options.taskId && envelope.agentAttempt === options.agentAttempt
  )
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const provided = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(token)
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}

const MAX_BODY_BYTES = 1024 * 1024

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) {
      throw new Error('broker request body exceeds 1 MiB')
    }
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}
