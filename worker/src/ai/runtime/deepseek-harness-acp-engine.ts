/**
 * One review attempt as a single DeepSeek Harness agent over ACP.
 *
 * Shape of one attempt: one child process, one session, one prompt turn. The
 * agent searches and reads the pinned commits through broker-mediated tools and
 * finishes by submitting a result. The turn ends because the submission was
 * committed, not because a fixed number of phases completed.
 *
 * The worker keeps every privilege: lease, credentials, snapshot roots,
 * verification and the database write. The child holds a socket path and a
 * token.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '../../logger.js'
import { redactError } from '../../security/redaction.js'
import type { RepositoryName } from '../../git/repositories.js'
import { runSingleAcpTurn } from '../acp/acp-client.js'
import { startAcpProcess, type AcpProcessHandle } from '../acp/acp-process-supervisor.js'
import {
  materializeAttemptProfile,
  type BudgetSpec,
  type MaterializedAttemptProfile,
  type ModelRouteSpec,
} from '../acp/profile-materializer.js'
import {
  startAttemptControlBroker,
  type AttemptControlHandle,
  type CommitReviewInput,
  type CommitReviewResult,
} from '../control/attempt-control-broker.js'
import type { SnapshotStore } from '../snapshot/snapshot-store.js'
import type { CoveragePolicy } from '../snapshot/search-coverage-ledger.js'
import {
  AGENT_REVIEW_PROMPT_VERSION,
  AGENT_REVIEW_SYSTEM_PROMPT,
  buildAgentReviewPrompt,
  type AgentReviewStory,
} from '../prompts/agent-review-v1.js'
import type {
  ReviewRunner,
  ReviewRunInput,
  ReviewRunResult,
  ReviewUsage,
} from './contracts.js'
import { ReviewExecutionAbortedError, ReviewExecutionError } from './errors.js'

export const AGENT_TOOL_NAMES = [
  'search_snapshot_code',
  'find_snapshot_files',
  'read_snapshot_code',
  'list_snapshot_commits',
  'submit_review_result',
] as const

export interface DeepSeekHarnessAcpEngineOptions {
  taskId: string
  agentAttempt: number
  branch: string
  story: AgentReviewStory
  snapshots: SnapshotStore
  route: ModelRouteSpec
  budgets: BudgetSpec
  coveragePolicy: CoveragePolicy
  /** Model key, read from the vault by the worker and never written to disk. */
  apiKey: string
  /** Directory that holds per-attempt profile trees. */
  attemptsRoot: string
  logger: Logger
  isLeaseValid(): boolean
  commitReview(input: CommitReviewInput): Promise<CommitReviewResult>
  /** Injected in tests to avoid spawning a real Harness process. */
  startProcess?: typeof startAcpProcess
  runTurn?: typeof runSingleAcpTurn
}

export class DeepSeekHarnessAcpEngine implements ReviewRunner {
  constructor(private readonly options: DeepSeekHarnessAcpEngineOptions) {}

  async runReview(input: ReviewRunInput): Promise<ReviewRunResult> {
    const log = input.logger.child({
      engine: 'deepseek-harness-acp',
      prompt_version: AGENT_REVIEW_PROMPT_VERSION,
    })

    if (input.signal.aborted) throw new ReviewExecutionAbortedError()

    // Fail before spawning anything if a pinned commit is not present locally.
    await this.options.snapshots.verifyPins()

    let broker: AttemptControlHandle | null = null
    let profile: MaterializedAttemptProfile | null = null
    let child: AcpProcessHandle | null = null
    const socketRoot = mkdtempSync(join(tmpdir(), 'crp-broker-'))
    const cwd = mkdtempSync(join(tmpdir(), 'crp-agent-cwd-'))
    // Agent 侧观测到的工具调用（含未到达 Broker 的），turn 抛错时也可用。
    const agentToolCalls: Record<string, number> = {}

    try {
      broker = await startAttemptControlBroker({
        taskId: this.options.taskId,
        agentAttempt: this.options.agentAttempt,
        snapshots: this.options.snapshots,
        coveragePolicy: this.options.coveragePolicy,
        socketRoot,
        logger: log,
        commitReview: this.options.commitReview,
        isLeaseValid: this.options.isLeaseValid,
      })

      profile = materializeAttemptProfile({
        taskId: this.options.taskId,
        agentAttempt: this.options.agentAttempt,
        attemptsRoot: this.options.attemptsRoot,
        route: this.options.route,
        budgets: this.options.budgets,
        broker: {
          socketPath: broker.socketPath,
          token: broker.token,
          requestTimeoutMs: this.options.route.requestTimeoutMs,
        },
        repositories: this.options.snapshots
          .pins()
          .map((pin) => pin.repository as RepositoryName),
      })

      broker.setConfigHash(profile.configHash)
      log.info('agent_attempt_started', {
        event: 'agent_attempt_started',
        config_hash: profile.configHash,
      })

      const startProcess = this.options.startProcess ?? startAcpProcess
      child = startProcess({
        dshHome: profile.dshHome,
        profileName: profile.profileName,
        patchPath: profile.patchPath,
        cwd,
        apiKeyEnvVar: this.options.route.apiKeyEnvVar,
        apiKey: this.options.apiKey,
      })

      const revokeOnAbort = () => broker?.revoke('the attempt was cancelled')
      input.signal.addEventListener('abort', revokeOnAbort, { once: true })

      const runTurn = this.options.runTurn ?? runSingleAcpTurn
      let turn
      try {
        turn = await runTurn(
          {
            process: child,
            cwd,
            permittedTools: [...AGENT_TOOL_NAMES],
            onToolCall: (name) => {
              agentToolCalls[name] = (agentToolCalls[name] ?? 0) + 1
            },
          },
          this.prompt(),
          input.signal,
        )
      } finally {
        input.signal.removeEventListener('abort', revokeOnAbort)
      }

      const usage = this.usage(broker)
      const committed = broker.committed()

      const brokerUsage = broker.usage()
      log.info('agent_attempt_finished', {
        event: 'agent_attempt_finished',
        stop_reason: turn.stopReason,
        tool_names: turn.toolNames,
        committed: committed !== null,
        tool_calls: usage.modelRequests,
        // 预算去向的分解：按工具分桶 + 提交被拒的错误码序列。
        tool_calls_by_name: brokerUsage.toolCallsByName,
        rejected_submissions: brokerUsage.rejectedSubmissions,
        evidence_shown: brokerUsage.evidenceShown,
        searches_run: brokerUsage.searchesRun,
      })

      if (!committed) {
        // 这条分支同样需要子进程 stderr：turn 以 cancelled/end_turn 收场却没有提交时，
        // 原因几乎只存在于 Harness 侧（插件加载失败、provider 解析不到、权限被拒），
        // 而它不是异常，不会走下面的 catch。缺了这行日志，这类失败在平台侧无迹可寻。
        const stderr = child.stderr()
        log.error('agent_attempt_no_submission', {
          event: 'agent_attempt_no_submission',
          stop_reason: turn.stopReason,
          tool_names: turn.toolNames,
          model_requests: usage.modelRequests,
          tool_calls_by_name: brokerUsage.toolCallsByName,
          rejected_submissions: brokerUsage.rejectedSubmissions,
          evidence_shown: brokerUsage.evidenceShown,
          searches_run: brokerUsage.searchesRun,
          // 协议层错误走 JSON-RPC 不走 stderr，两者都要记。
          prompt_error: turn.promptError,
          child_stderr_bytes: stderr.length,
          child_stderr_tail: stderr === '' ? null : redactError(tailOf(stderr, 4000)),
        })
      }

      if (!committed) {
        // A turn that ends without a committed result is a failure even when
        // the protocol reported a clean stop: nothing was persisted.
        return {
          taskId: this.options.taskId,
          storyCode: this.options.story.code,
          ok: false,
          errorCode:
            turn.stopReason === 'end_turn' ? 'AGENT_NO_SUBMISSION' : 'AGENT_TURN_INCOMPLETE',
          errorMessage: `agent turn ended as ${turn.stopReason} without committing a review result`,
          usage,
        }
      }

      return {
        taskId: this.options.taskId,
        storyCode: this.options.story.code,
        ok: true,
        usage,
      }
    } catch (err) {
      const code =
        err instanceof ReviewExecutionError
          ? err.code
          : ((err as { code?: string })?.code ?? 'AGENT_ATTEMPT_FAILED')
      const message = redactError(err)
      // 子进程 stderr 是唯一能说明"模型/适配器到底报了什么"的来源。以前这里只记
      // 字节数，等于把它扔了：一次 attempt 失败在平台侧完全不可诊断。这里记录经过
      // 脱敏的尾部内容，并同时带上已发生的工具调用，好区分"模型没调工具"和
      // "工具一直失败"。
      const stderr = child?.stderr() ?? ''
      const failureUsage = broker?.usage() ?? null
      log.error('agent_attempt_failed', {
        event: 'agent_attempt_failed',
        error_code: code,
        error_message: message,
        child_stderr_bytes: stderr.length,
        child_stderr_tail: stderr === '' ? null : redactError(tailOf(stderr, 4000)),
        broker_tool_calls: failureUsage?.toolCalls ?? 0,
        broker_evidence_shown: failureUsage?.evidenceShown ?? 0,
        // 预算耗尽走的正是这条路径，分解必须在这里也有。
        tool_calls_by_name: failureUsage?.toolCallsByName ?? {},
        rejected_submissions: failureUsage?.rejectedSubmissions ?? [],
        searches_run: failureUsage?.searchesRun ?? 0,
        // Agent 侧计数与 Broker 侧对不上，说明有工具调用没走到 Worker。
        agent_tool_calls: { ...agentToolCalls },
      })
      return {
        taskId: this.options.taskId,
        storyCode: this.options.story.code,
        ok: false,
        errorCode: code,
        errorMessage: message,
        usage: broker ? this.usage(broker) : undefined,
      }
    } finally {
      broker?.revoke('the attempt has finished')
      if (child) {
        await child.terminate().catch(() => undefined)
      }
      await broker?.close().catch(() => undefined)
      profile?.cleanup()
      rmSync(socketRoot, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  private prompt(): string {
    return `${AGENT_REVIEW_SYSTEM_PROMPT}\n\n---\n\n${buildAgentReviewPrompt({
      story: this.options.story,
      branch: this.options.branch,
      pins: this.options.snapshots.pins(),
      // 让模型知道自己的硬上限：不告知的实测后果是它一直检索、从不提交。
      maxModelRequests: this.options.budgets.maxLoopRequests,
    })}`
  }

  private usage(broker: AttemptControlHandle): ReviewUsage {
    const snapshot = broker.usage()
    return {
      source: 'harness-governor',
      // Tool traffic is authoritative on this side of the socket; token counts
      // are not observable here and must not be invented.
      modelRequests: snapshot.toolCalls,
      retryRequests: snapshot.retryRequests,
      compactionRequests: snapshot.compactionRequests,
      inputTokens: null,
      outputTokens: null,
    }
  }
}

/**
 * 取字符串尾部若干字符。
 *
 * 取尾而不是取头：Harness 子进程的 stderr 往往以启动噪音开头，真正的失败原因在
 * 最后。截断处加标记，避免把截断后的内容误读成完整日志。
 */
export function tailOf(value: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (value.length <= maxChars) return value
  return `…[truncated ${value.length - maxChars} chars]…${value.slice(-maxChars)}`
}
