/**
 * 一轮产品代码问答的执行体（V1.23）。
 *
 * 它做的事：
 *
 * ```text
 * 认领到的一轮
 *   → 确定代码基线（首轮解析分支头并冻结到会话；后续轮复用会话冻结的 SHA）
 *   → 物化 per-turn 的 DSH profile（只读策略 + 平台技能目录 + 只读快照工具）
 *   → spawn dsh (ACP)
 *   → session/load(既有会话) 或 session/new
 *   → 一次 session/prompt
 *   → 收 Agent 正文与工具调用观测
 *   → submit_code_qa_turn_result(答案 + 证据)
 * ```
 *
 * 三条边界写在代码结构里，不只写在注释里：
 *
 *   1. **不提交任何评审结论。** 这个模块没有任何调用 `commitReview` 的路径；Broker 的
 *      那个回调被接成"一旦被调用就抛错"，而 `submit_review_result` 本来就不在问答的
 *      工具面里（`assertCodeQaToolsReadOnly` 在启动前 fail closed）。
 *   2. **不新建代码基线。** `bind_code_qa_conversation_snapshot` 的**返回值**才是权威 SHA。
 *      本地解析出的 SHA 与它不一致时用返回值，因为会话的前几轮已经基于那一版回答过了。
 *   3. **续跑失败不静默降级。** `session/load` 不可用时报
 *      `CODE_QA_SESSION_RESUME_FAILED`，而不是偷偷 `session/new` —— 后者会让模型忘掉
 *      上文而用户以为它记得。
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  runSingleAcpTurn,
  SessionResumeUnsupportedError,
  type AcpTurnResult,
} from '../acp/acp-client.js'
import { startAcpProcess, type AcpProcessHandle } from '../acp/acp-process-supervisor.js'
import { materializeAttemptProfile } from '../acp/profile-materializer.js'
import { startAttemptControlBroker } from '../control/attempt-control-broker.js'
import {
  AgentAuthorityLedger,
  mintRootIdentity,
} from '../control/agent-authority-ledger.js'
import { HierarchicalBudgetLedger } from '../control/hierarchical-budget-ledger.js'
import { policyHash as hashPolicy } from '../policy/v4-capability-policy.js'
import { SnapshotStore } from '../snapshot/snapshot-store.js'
import type { ProvisionedSkill } from '../skills/skill-provisioner.js'
import {
  assertCodeQaToolsReadOnly,
  buildCodeQaPolicy,
  CODE_QA_AGENT_ROLE,
  CODE_QA_DENIED_TOOLS,
  CODE_QA_PERMITTED_TOOLS,
} from './qa-policy.js'
import { buildCodeQaPrompt, collectReadFiles } from './qa-prompt.js'
import {
  prepareRepository,
  prepareRepositoryAtSnapshot,
  type PreparedRepository,
} from '../../git/prepare.js'
import {
  assertBranch,
  assertRepositoryName,
  type BranchName,
  type RepositoryName,
} from '../../git/repositories.js'
import {
  hostProxyChildEnv,
  resolveModelNetworkRoute,
  ModelNetworkRouteError,
} from '../../model-connectivity/network-mode.js'
import type { ModelProxySettings } from '../../model-connectivity/probe.js'
import type {
  CodeQaEvidencePayload,
  CodeQaTurnClaim,
  CodeQaTurnClaimRef,
  JobsDb,
} from '../../db/jobs.js'
import type { Logger } from '../../logger.js'

/**
 * 模型 Key 的环境变量名。
 *
 * 名字里必须含 `KEY`（命中 Harness 的 `SENSITIVE_ENV_PATTERN`
 * `/KEY|PASSWORD|SECRET|TOKEN/i`），否则 Harness 在 spawn Shell 前不会把它剥掉。
 * 问答的沙箱是 read-only、没有 bash，但这个约定不能靠"当前没有 Shell"来豁免 ——
 * 以后有人放宽策略时，忘掉这一行的后果是把模型 Key 交给 Shell。
 */
export const CODE_QA_MODEL_API_KEY_ENV = 'CODE_QA_MODEL_API_KEY'

export const CODE_QA_ERROR_CODES = {  SNAPSHOT_FAILED: 'CODE_QA_SNAPSHOT_FAILED',
  SESSION_RESUME_FAILED: 'CODE_QA_SESSION_RESUME_FAILED',
  ANSWER_EMPTY: 'CODE_QA_ANSWER_EMPTY',
  TOOL_SURFACE: 'CODE_QA_TOOL_SURFACE_NOT_READ_ONLY',
  TIMEOUT: 'CODE_QA_TIMEOUT',
  FAILED: 'CODE_QA_FAILED',
} as const

export interface CodeQaSessionDeps {
  jobsDb: JobsDb
  workerId: string
  /** Git 与目录配置。 */
  paths: {
    codeCacheRoot: string
    agentAttemptsRoot: string
    sessionRoot: string
    /** Broker 的 unix socket 根目录。 */
    socketRoot: string
  }
  git: {
    authMode: 'local' | 'token'
    gitlabBaseUrl: string
    deployUser: string | null
    deployToken: string | null
  }
  /** 这台 Worker 配置的宿主机代理；是否使用由冻结的网络类型决定。 */
  modelProxy: ModelProxySettings | null
  /** 本次挂载的平台技能目录。缺省等价于空目录（隔离配置仍然写入）。 */
  skills?: { catalogHash: string; bundles: readonly ProvisionedSkill[] }
  logger: Logger
  signal?: AbortSignal
  /** 单轮时长上限。到点即终态失败，不无限续租。 */
  turnTimeoutMs?: number

  // —— 注入点：单测用假实现，生产用真实现 ——
  prepareAtSnapshot?: typeof prepareRepositoryAtSnapshot
  prepareAtBranchHead?: typeof prepareRepository
  startProcess?: typeof startAcpProcess
  runTurn?: typeof runSingleAcpTurn
  startBroker?: typeof startAttemptControlBroker
}

export interface CodeQaTurnOutcome {
  status: 'SUCCEEDED' | 'FAILED'
  errorCode?: string
  /** 实际使用的代码基线，按仓库。 */
  commitShas?: Record<string, string>
  answerChars?: number
  toolCallCount?: number
  resumed?: boolean
}

/** 只回一行原因，且截断：错误信息会落库并显示给产品，不能带代码片段。 */
function reason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const single = raw.replace(/\s+/g, ' ').trim()
  return single.length > 300 ? `${single.slice(0, 300)}…` : single
}

/**
 * 把执行期错误映射成稳定错误码。
 *
 * 分得细是有代价的，但混成一个 `CODE_QA_FAILED` 的代价更大：产品看到"回答失败"时
 * 唯一想知道的是"该我做什么"——重试、换个说法、新建会话、还是找管理员。这几种处置
 * 完全不同（见 `src/lib/code-qa.ts` 的 ERROR_HINTS）。
 */
export function classifyCodeQaError(error: unknown): string {
  if (error instanceof SessionResumeUnsupportedError) {
    return CODE_QA_ERROR_CODES.SESSION_RESUME_FAILED
  }
  if (error instanceof ModelNetworkRouteError) return error.code
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code.startsWith('CODE_QA_')) return code
  const message = error instanceof Error ? error.message : String(error)
  // Git 侧的错误码原样透出：产品看到"分支不存在"能自己改，看到"回答失败"只能重试。
  for (const known of [
    'CODE_QA_TOOL_SURFACE_NOT_READ_ONLY',
    'CODE_QA_SESSION_RESUME_FAILED',
    'TASK_LEASE_LOST',
    'MODEL_SECRET_MISSING',
    'MODEL_CONFIG_NOT_FOUND',
  ]) {
    if (message.includes(known)) return known
  }
  for (const gitCode of ['GIT_SHA_MISMATCH', 'GIT_BRANCH_MISSING', 'GIT_AUTH_FAILED']) {
    if (message.includes(gitCode)) return CODE_QA_ERROR_CODES.SNAPSHOT_FAILED
  }
  return CODE_QA_ERROR_CODES.FAILED
}

/**
 * 确定这一轮使用的代码基线 —— 每个选中的仓库各一份。
 *
 * 每个仓库独立冻结：首轮解析分支头并写进会话的 `commit_shas`，后续轮直接取已冻结值。
 * **冻结 RPC 的返回值是权威的** —— 并发下两个 Worker 可能同时解析出不同的头，
 * 数据库只让第一个写进去，第二个必须服从。
 *
 * 顺序按 `repositories` 给的顺序（数据库已排序），让提示词与快照挂载顺序稳定。
 */
export async function resolveCodeQaSnapshots(
  claim: CodeQaTurnClaim,
  claimRef: CodeQaTurnClaimRef,
  deps: CodeQaSessionDeps,
): Promise<PreparedRepository[]> {
  // 双侧校验：数据库侧有 CHECK，这里再断言一次。两边都不信对方。
  const branch: BranchName = assertBranch(claim.branch)
  if (claim.repositories.length === 0) {
    throw Object.assign(new Error('这个会话没有选中任何仓库'), {
      code: CODE_QA_ERROR_CODES.SNAPSHOT_FAILED,
    })
  }
  const prepareOptions = {
    cacheRoot: deps.paths.codeCacheRoot,
    authMode: deps.git.authMode,
    gitlabBaseUrl: deps.git.gitlabBaseUrl,
    deployUser: deps.git.deployUser,
    deployToken: deps.git.deployToken,
  }
  const atSnapshot = deps.prepareAtSnapshot ?? prepareRepositoryAtSnapshot
  const atBranchHead = deps.prepareAtBranchHead ?? prepareRepository

  const prepared: PreparedRepository[] = []
  for (const name of claim.repositories) {
    const repository: RepositoryName = assertRepositoryName(name)
    const frozenSha = claim.commit_shas[repository]

    if (frozenSha !== undefined) {
      prepared.push(await atSnapshot(repository, branch, frozenSha, prepareOptions))
      continue
    }

    const head = await atBranchHead(repository, branch, prepareOptions)
    const frozen = await deps.jobsDb.bindCodeQaConversationSnapshot({
      ...claimRef,
      repository,
      commitSha: head.commitSha,
    })
    if (frozen === head.commitSha) {
      prepared.push(head)
      continue
    }
    // 另一个 Worker 抢先冻结了别的 SHA（或会话早已冻结）。服从数据库，重新取那一版。
    deps.logger.info('code_qa_snapshot_rebased_to_frozen', {
      event: 'code_qa_snapshot_rebased_to_frozen',
      conversation_id: claim.conversation_id,
      repository,
    })
    prepared.push(await atSnapshot(repository, branch, frozen, prepareOptions))
  }
  return prepared
}

/**
 * 为这一轮搭一个把所有选中仓库并列在一起的工作目录。
 *
 * ```text
 * <attemptsRoot>/code-qa-ws-<turn>/
 *   kdmanage-backend  -> <cacheRoot>/kdmanage-backend/<sha>   (symlink)
 *   kdmanage-frontend -> <cacheRoot>/kdmanage-frontend/<sha>  (symlink)
 * ```
 *
 * 为什么要这一层：Agent 的 cwd 只能是一个目录，而多仓库的快照分散在
 * `<cacheRoot>/<repo>/<sha>/` 下，没有一个既包含它们、又不包含别的 SHA 的共同父目录。
 * 把 `<cacheRoot>` 直接当 cwd 会让模型看到同一个仓库的历史快照，那比看不到更糟。
 *
 * 用符号链接而不是复制：这些仓库是几百 MB 的真实代码库，复制一份的代价与收益完全不成
 * 比例，而且快照本来就是只读的。
 *
 * **失败不致命**：建不出链接时退回"只把第一个仓库当 cwd"，并记一行日志。此时
 * `read` / `grep` / `glob` 只覆盖第一个仓库，但 `search_snapshot_code` /
 * `read_snapshot_code` 这些按仓库名工作的快照工具**全部仓库照常可用** —— 它们不依赖
 * cwd，所以多仓库问答仍然能工作，只是文件系统那一路窄一些。
 */
export function materializeCodeQaWorkspace(input: {
  attemptsRoot: string
  turnId: string
  prepared: readonly PreparedRepository[]
  logger: Logger
}): { cwd: string; linked: boolean; cleanup: () => void } {
  const single = input.prepared[0]
  if (single === undefined) throw new Error('no prepared repository')
  // 单仓库不需要这一层：直接用快照目录，行为与多仓库之前完全一致。
  if (input.prepared.length === 1) {
    return { cwd: single.path, linked: false, cleanup: () => undefined }
  }

  const root = join(input.attemptsRoot, `code-qa-ws-${input.turnId}`)
  try {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true, mode: 0o700 })
    for (const repo of input.prepared) {
      symlinkSync(repo.path, join(root, repo.repository), 'dir')
    }
    return {
      cwd: root,
      linked: true,
      cleanup: () => {
        // 只删链接树本身。`rmSync` 不会跟随符号链接删掉目标，所以共享的代码缓存安全。
        try {
          rmSync(root, { recursive: true, force: true })
        } catch {
          // 残留目录由周期清理回收，不影响这一轮的结论。
        }
      },
    }
  } catch (error) {
    input.logger.warn('code_qa_workspace_link_failed', {
      event: 'code_qa_workspace_link_failed',
      repository_count: input.prepared.length,
      error_message: error instanceof Error ? error.name : 'UNKNOWN',
    })
    return { cwd: single.path, linked: false, cleanup: () => undefined }
  }
}
/**
 * 执行一轮问答。
 *
 * 失败一律通过 `submit_code_qa_turn_failure` 写回终态，不重排队 —— 一次提问变成多条
 * 轮次只会让产品在页面上看到一个反复重来的进度条。
 */
export async function runCodeQaTurn(
  claim: CodeQaTurnClaim,
  deps: CodeQaSessionDeps,
): Promise<CodeQaTurnOutcome> {
  const log = deps.logger.child({
    code_qa_turn_id: claim.turn_id,
    conversation_id: claim.conversation_id,
  })
  const claimRef: CodeQaTurnClaimRef = {
    turnId: claim.turn_id,
    workerId: deps.workerId,
    claimToken: claim.claim_token,
  }
  const policy = buildCodeQaPolicy()
  const policyHashValue = hashPolicy(policy)
  const identity = mintRootIdentity(claim.conversation_id, 1)

  let apiKey: string | null = null
  let broker: Awaited<ReturnType<typeof startAttemptControlBroker>> | null = null
  let profileCleanup: (() => void) | null = null
  let processHandle: AcpProcessHandle | null = null
  const answerParts: string[] = []
  const toolDetails: Array<{ toolName: string; arguments?: Record<string, unknown> }> = []
  const skillsUsed = new Set<string>()
  let resumed = false
  let commitShas: Record<string, string> = { ...claim.commit_shas }
  // 失败路径也要归一路径，但那时 workspace 可能还不存在。
  let workspaceRoot: string | null = null
  let workspaceCleanup: (() => void) | null = null
  let reportedGenerating = false

  try {
    const route = resolveModelNetworkRoute({
      mode: claim.network_access_mode_snapshot,
      configuredProxy: deps.modelProxy,
    })

    // 1. 代码基线 —— 每个选中的仓库各一份。
    const prepared = await resolveCodeQaSnapshots(claim, claimRef, deps)
    commitShas = Object.fromEntries(prepared.map((r) => [r.repository, r.commitSha]))
    log.info('code_qa_snapshot_ready', {
      event: 'code_qa_snapshot_ready',
      branch: prepared[0]!.branch,
      repository_count: prepared.length,
      repositories: prepared.map((r) => r.repository),
      commit_shas: commitShas,
      cached_count: prepared.filter((r) => r.cached).length,
    })

    // 多仓库需要一个把它们并列起来的 cwd；单仓库直接用快照目录。
    const workspace = materializeCodeQaWorkspace({
      attemptsRoot: deps.paths.agentAttemptsRoot,
      turnId: claim.turn_id,
      prepared,
      logger: log,
    })
    workspaceRoot = workspace.cwd
    workspaceCleanup = workspace.cleanup
    if (prepared.length > 1) {
      log.info('code_qa_workspace_ready', {
        event: 'code_qa_workspace_ready',
        repository_count: prepared.length,
        linked: workspace.linked,
      })
    }

    const snapshots = new SnapshotStore(
      prepared.map((repo) => ({
        name: repo.repository,
        commitSha: repo.commitSha,
        gitDir: repo.path,
      })),
    )

    // 2. 治理面。问答只有一个 Agent，所以这两个账本都是最小配置。
    const authority = new AgentAuthorityLedger({
      taskId: claim.conversation_id,
      agentAttempt: 1,
      policy,
      rootAgentId: identity.rootAgentId,
      rootSessionId: identity.rootSessionId,
    })
    const budget = new HierarchicalBudgetLedger({ policy })

    // 3. Broker：只读快照工具的唯一通道。
    mkdirSync(deps.paths.socketRoot, { recursive: true, mode: 0o700 })
    const control = await (deps.startBroker ?? startAttemptControlBroker)({
      taskId: claim.conversation_id,
      agentAttempt: 1,
      sessionRevision: 1,
      snapshots,
      // 问答不要求覆盖率：它回答一个具体问题，不是做一次完整评审。
      coveragePolicy: { requiredRepositories: [], minQueriesPerRepository: 0 },
      socketRoot: deps.paths.socketRoot,
      logger: log,
      policy,
      policyHash: policyHashValue,
      skillBundleHashes: new Map(
        (deps.skills?.bundles ?? []).map(
          (provisioned) => [provisioned.bundle.name, provisioned.bundle.bundleHash] as const,
        ),
      ),
      authority,
      budget,
      /*
       * 评审提交在问答里**不可达**。
       *
       * `submit_review_result` 不在问答的工具面里（`assertCodeQaToolsReadOnly` 在
       * 启动前就会 fail closed），所以这条路由永远不会被走到。接成抛错而不是接成
       * 空实现：万一以后有人放宽了工具面，它必须炸，而不是静默接受一条没有批次、
       * 没有需求的"评审结论"。
       */
      commitReview: () => {
        throw new Error('CODE_QA_REVIEW_SUBMISSION_FORBIDDEN: code QA cannot commit a review')
      },
      isLeaseValid: () => true,
    })
    broker = control

    // 4. profile。只读策略 + 平台技能目录。
    const profile = materializeAttemptProfile({
      taskId: claim.conversation_id,
      agentAttempt: 1,
      attemptsRoot: deps.paths.agentAttemptsRoot,
      route: {
        providerId: 'code-qa-route',
        displayName: claim.model_name_snapshot,
        baseUrl: claim.base_url_snapshot,
        modelName: claim.model_name_snapshot,
        contextWindow: 131072,
        maxTokens: claim.max_output_tokens_snapshot ?? 8192,
        apiKeyEnvVar: CODE_QA_MODEL_API_KEY_ENV,
        requestTimeoutMs: claim.request_timeout_ms_snapshot,
        // 问答不读图：产品问的是代码逻辑。过度声明模态在图片发出去之后才会失败，
        // 而那时错误看起来像模型的问题而不是配置的问题（见 profile-materializer 注释）。
        inputModalities: ['text'],
      },
      policy,
      // 根 Agent 用只读角色。这是问答工具面的唯一收窄点：`rootTools` 会进
      // agent-authority-policy 的配置，不传就意味着根 Agent 拿到评审角色的全部工具
      // （含 submit_review_result）。本地端到端实测过：不传时
      // assertCodeQaToolsReadOnly 在 spawn 之前就拒绝了这一轮。
      rootRole: CODE_QA_AGENT_ROLE,
      identity: {
        rootAgentId: identity.rootAgentId,
        rootSessionId: identity.rootSessionId,
      },
      cwd: workspace.cwd,
      // 会话 JSONL 与评审共用持久卷，但目录前缀独立：清理与保留期各自计算。
      sessionRoot: join(deps.paths.sessionRoot, 'code-qa'),
      broker: {
        socketPath: control.socketPath,
        requestTimeoutMs: claim.request_timeout_ms_snapshot,
      },
      repositories: prepared.map((r) => r.repository),
      skills: {
        catalogHash: deps.skills?.catalogHash ?? '',
        bundles: deps.skills?.bundles ?? [],
      },
    })
    profileCleanup = profile.cleanup
    control.setConfigHash(profile.configHash)

    /*
     * 5. fail closed：解析出来的工具面必须是只读的。
     *
     * 放在 spawn **之前**。放在之后等于"先把能改代码的工具交给模型，再检查该不该给"。
     */
    assertCodeQaToolsReadOnly(profile.rootTools)

    /*
     * 故事相关工具在问答里没有语义，但**策略层去不掉它们**：`list_story_commits` /
     * `read_story_commit_diff` 不受任何 capability 开关控制，只由角色集合决定。
     *
     * 后果是有界的：它们经 Broker 的 `/attempt/list-story-commits` 路由，而问答的 Broker
     * 没有 `analysisScope`，那条路由会直接拒绝。所以最坏情况是模型白调一次然后拿到错误。
     * 这里把它记成一行日志而不是静默忽略 —— 否则"为什么模型调了一个必然失败的工具"
     * 这个问题在运维侧没有任何线索。
     */
    const uselessTools = profile.rootTools.filter((tool) => CODE_QA_DENIED_TOOLS.includes(tool))
    if (uselessTools.length > 0) {
      log.info('code_qa_inert_tools_exposed', {
        event: 'code_qa_inert_tools_exposed',
        tools: uselessTools,
      })
    }

    const skillNames = profile.skills.skills.map((skill) => skill.name)
    log.info('code_qa_profile_ready', {
      event: 'code_qa_profile_ready',
      skill_catalog_count: skillNames.length,
      tool_count: profile.rootTools.length,
      resume_target: claim.dsh_session_id === null ? 'new' : 'load',
    })

    // 6. Key。只存在于这个函数的局部变量，finally 置空，不进日志。
    apiKey = await deps.jobsDb.getModelSecretForCodeQaTurn(claimRef)

    // 7. 提示词。
    const willResume = claim.dsh_session_id !== null
    const prompt = buildCodeQaPrompt({
      question: claim.question,
      context: {
        repositories: prepared.map((r) => ({
          name: r.repository,
          commitSha: r.commitSha,
        })),
        branch: prepared[0]!.branch,
        skillNames,
        // 多仓库时告诉模型各仓库在 cwd 下按名字并列；单仓库时 cwd 就是仓库根。
        multiRepoWorkspace: prepared.length > 1,
      },
      resumed: willResume,
    })

    /*
     * 8. 把硬规则写进 `<dshHome>/AGENTS.md`。
     *
     * **这是唯一真正生效的注入通道。** `runSingleAcpTurn(options, prompt, signal)` 只收
     * 一条 prompt 字符串，没有 system 参数 —— 早先这里构造了 `prompt.system` 却从没用过，
     * 后果是线上第一版的回答用英文、罗列自己能做什么、不给文件路径：四条硬规则一条都没
     * 送到模型，而没有任何错误码能发现（一次"成功"的问答，只是质量全错）。
     *
     * DSH 的 `agent-instructions` 插件会把用户全局 `$DSH_HOME/AGENTS.md` 作为**第一次请求
     * 的持久基线消息**注入，会话恢复时也会对账基线 —— 正好是 system prompt 的语义。
     * 而 `dshHome` 是 per-attempt 我们自己创建的可写目录，不用碰只读的代码快照。
     *
     * 续跑轮也要写：per-turn 的 dshHome 是新建的临时目录，上一轮那份随目录一起被清理了。
     */
    writeFileSync(join(profile.dshHome, 'AGENTS.md'), `${prompt.system}\n`, { mode: 0o600 })
    log.info('code_qa_instructions_written', {
      event: 'code_qa_instructions_written',
      bytes: Buffer.byteLength(prompt.system, 'utf8'),
    })

    processHandle = await (deps.startProcess ?? startAcpProcess)({
      dshHome: profile.dshHome,
      profileName: profile.profileName,
      patchPath: profile.patchPath,
      cwd: workspace.cwd,
      apiKeyEnvVar: CODE_QA_MODEL_API_KEY_ENV,
      apiKey,
      brokerToken: control.token,
      rootCapability: authority.rootCapabilityToken,
      // 内网模型经宿主机代理。环境变量是唯一可行的机制（llm-pi-ai 没有 per-provider
      // 代理配置），代价见 network-mode.ts 的 hostProxyChildEnv 注释。
      ...(route.proxy ? { extraEnv: hostProxyChildEnv(route.proxy) } : {}),
    })

    await deps.jobsDb
      .reportCodeQaTurnStage({ ...claimRef, stage: 'EXPLORING' })
      .catch(() => false)

    const turnController = new AbortController()
    const abortOuter = () => turnController.abort()
    deps.signal?.addEventListener('abort', abortOuter, { once: true })
    const timeoutMs = deps.turnTimeoutMs ?? 15 * 60 * 1000
    const timeout = setTimeout(() => turnController.abort(), timeoutMs)

    let turn: AcpTurnResult
    try {
      turn = await (deps.runTurn ?? runSingleAcpTurn)(
        {
          process: processHandle,
          cwd: workspace.cwd,
          clientName: 'code-qa-worker',
          // 必须显式传空数组：默认值是 ['submit_review_result']。
          permittedTools: [...CODE_QA_PERMITTED_TOOLS],
          ...(willResume ? { resumeSessionId: claim.dsh_session_id as string } : {}),
          onSessionCreated: (sessionId, wasResumed) => {
            resumed = wasResumed
            // 立刻写回：turn 要跑几十秒，容器在这期间被重建时这一轮的会话身份就丢了，
            // 而下一轮会因此从零开始（模型忘掉上文）。
            void deps.jobsDb
              .bindCodeQaConversationSession({
                ...claimRef,
                dshSessionId: sessionId,
                skillCatalogHash: deps.skills?.catalogHash ?? null,
              })
              .catch((error) =>
                log.warn('code_qa_session_bind_failed', {
                  event: 'code_qa_session_bind_failed',
                  error_message: reason(error),
                }),
              )
          },
          onToolCallDetail: (detail) => {
            toolDetails.push({
              toolName: detail.toolName,
              ...(detail.rawInput ? { arguments: detail.rawInput } : {}),
            })
            if (detail.toolName === 'skill') {
              const name = detail.rawInput?.name ?? detail.rawInput?.skill
              if (typeof name === 'string' && name !== '') skillsUsed.add(name)
            }
          },
          onAgentMessageChunk: (text) => {
            answerParts.push(text)
            // 第一段正文到达 = 真的开始写回答了。这是"正在组织回答"唯一的事实依据。
            if (!reportedGenerating) {
              reportedGenerating = true
              void deps.jobsDb
                .reportCodeQaTurnStage({ ...claimRef, stage: 'GENERATING' })
                .catch(() => false)
            }
          },
        },
        prompt.user,
        turnController.signal,
      )
    } finally {
      clearTimeout(timeout)
      deps.signal?.removeEventListener('abort', abortOuter)
    }

    const answer = answerParts.join('').trim()
    log.info('code_qa_turn_observed', {
      event: 'code_qa_turn_observed',
      stop_reason: turn.stopReason,
      updates: turn.updates,
      tool_call_count: toolDetails.length,
      resumed: turn.resumed,
      answer_chars: answer.length,
    })

    if (answer === '') {
      // 空答案不是成功。数据库侧也会拒绝（CODE_QA_ANSWER_EMPTY），这里先给出更准确的原因。
      throw Object.assign(
        new Error(
          turn.promptError !== null
            ? `模型没有产出回答：${turn.promptError}`
            : `模型没有产出回答（stopReason=${turn.stopReason}）`,
        ),
        { code: CODE_QA_ERROR_CODES.ANSWER_EMPTY },
      )
    }

    const evidence: CodeQaEvidencePayload = {
      commit_shas: commitShas,
      repositories: prepared.map((r) => r.repository),
      files_read: collectReadFiles(toolDetails, { workspaceRoot: workspace.cwd }),
      skills_used: [...skillsUsed].sort(),
      tool_call_count: toolDetails.length,
      resumed: turn.resumed,
      update_count: turn.updates,
    }
    await deps.jobsDb.submitCodeQaTurnResult({ ...claimRef, answer, evidence })

    return {
      status: 'SUCCEEDED',
      commitShas,
      answerChars: answer.length,
      toolCallCount: toolDetails.length,
      resumed: turn.resumed,
    }
  } catch (error) {
    const errorCode = classifyCodeQaError(error)
    log.warn('code_qa_turn_failed', {
      event: 'code_qa_turn_failed',
      error_code: errorCode,
      tool_call_count: toolDetails.length,
    })
    if (errorCode === 'TASK_LEASE_LOST') {
      // 租约已经不是我们的了，写回只会再撞一次同样的拒绝。
      return { status: 'FAILED', errorCode }
    }
    await deps.jobsDb
      .submitCodeQaTurnFailure({
        ...claimRef,
        errorCode,
        errorMessage: reason(error),
        evidence: {
          ...(Object.keys(commitShas).length > 0 ? { commit_shas: commitShas } : {}),
          repositories: claim.repositories,
          files_read: collectReadFiles(toolDetails, { workspaceRoot: workspaceRoot ?? undefined }),
          tool_call_count: toolDetails.length,
          resumed,
        },
      })
      .catch(() => undefined)
    return { status: 'FAILED', errorCode, commitShas }
  } finally {
    apiKey = null
    if (processHandle) {
      await processHandle.terminate().catch(() => undefined)
      await processHandle.reapProcessTree().catch(() => undefined)
    }
    await broker?.close().catch(() => undefined)
    try {
      workspaceCleanup?.()
    } catch {
      // 同下：清理失败不改变结论。
    }
    try {
      profileCleanup?.()
    } catch {
      // 清理失败不改变这一轮的结论；孤儿目录由周期清理回收。
    }
  }
}
