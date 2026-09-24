/**
 * 技能 AI 优化的执行体（V1.19）。
 *
 * 它做的事只有一件：**替管理员预先填好一次 ZIP 上传**。
 *
 * ```text
 * 下载当前发布版本 ZIP → 解包（文本取正文、图片只取身份）→ 读历史评审证据
 *   → 调模型 → fail-closed 解析 → 未改动文件保持原字节、改动文件换新内容、删除的去掉
 *   → **结构自检**（与人工上传完全相同的 validateSkillArchive）
 *       ├─ 不通过：把拒绝原因回灌给模型，让它自己改，最多 MAX_MODEL_ATTEMPTS 次
 *       └─ 通过：走既有 admin_register_skill_upload + admin_record_skill_upload_validation
 *   → submit_skill_ai_optimization_result
 * ```
 *
 * 三条边界写在代码结构里，不只写在注释里：
 *
 *   1. **不发布。** 这个模块没有任何调用 `admin_publish_review_skill_version` 的路径。
 *      发布只能由管理员在看完 diff 之后手动触发。
 *   2. **不绕校验。** 打包产物被当成一份陌生上传重新跑 `validateSkillArchive`，然后把结果
 *      交给与人工上传**同一个** RPC 落库。自检不通过时不产出任何草稿。
 *   3. **二进制字节不变。** 图片用原归档解出来的 Buffer 原样写回，模型只能删除它们，
 *      不可能间接改写。
 */

import { randomUUID } from 'node:crypto'

import {
  SkillBundleInvalidError,
  SkillBundleLimitError,
  validateSkillArchive,
  type ValidatedSkillBundle,
} from './bundle-validator.js'
import { SKILL_BUNDLE_LIMITS, type SkillBundleLimits } from './skill-limits.js'
import { requiresUtf8, roleForPath, SKILL_ENTRY_FILE } from './skill-manifest.js'
import {
  buildSkillOptimizationPrompt,
  parseSkillOptimizationOutput,
  SkillOptimizationNoChangeError,
  SkillOptimizationOutputError,
  type ParsedSkillOptimization,
  type SkillBundleFileView,
  type SkillReviewEvidenceSnapshot,
} from './skill-optimization-prompt.js'
import { writeSkillArchive } from './zip-writer.js'
import { readSkillArchive } from './zip-archive.js'
import type { SkillStagingWriter, SkillStorageClient } from './skill-storage.js'
import type { JobsDb, SkillAiOptimizationClaim } from '../../db/jobs.js'
import type { Logger } from '../../logger.js'
import {
  ChatCompletionError,
  requestChatCompletion,
  type ChatCompletionRequest,
  type ChatCompletionResult,
} from '../../model-connectivity/chat-completion.js'
import {
  ModelNetworkRouteError,
  resolveModelNetworkRoute,
} from '../../model-connectivity/network-mode.js'
import type { ModelProxySettings } from '../../model-connectivity/probe.js'

/** 输出上限。整包文本最多几十 KiB，按最坏情况 1 token ≈ 2 字节留足余量。 */
const MAX_COMPLETION_TOKENS = 60000

/**
 * 自检不通过时最多让模型重写几次。
 *
 * 3 次是成本与收获的折中：第一次通常是格式或上限问题（回灌原因后大概率能修），第三次还不过
 * 说明模型没能力满足这个结构要求，再试下去只是在烧 token 而管理员一直看着进度条。
 */
export const MAX_MODEL_ATTEMPTS = 3

export const SKILL_OPTIMIZATION_ERROR_CODES = {
  ARCHIVE_UNREADABLE: 'SKILL_OPTIMIZATION_SOURCE_UNREADABLE',
  NO_EVIDENCE: 'SKILL_OPTIMIZATION_NO_EVIDENCE',
  MODEL_OUTPUT_INVALID: 'SKILL_OPTIMIZATION_MODEL_OUTPUT_INVALID',
  /** 模型看完证据后判断不该改。终态，但不是"模型写错了"。 */
  NO_CHANGE_NEEDED: 'SKILL_OPTIMIZATION_NO_CHANGE_NEEDED',
  REPACK_REJECTED: 'SKILL_OPTIMIZATION_REPACK_REJECTED',
  FAILED: 'SKILL_OPTIMIZATION_FAILED',
} as const

export interface SkillAiOptimizationDeps {
  jobsDb: JobsDb
  storage: SkillStorageClient & SkillStagingWriter
  workerId: string
  /** 这台 Worker 配置的宿主机代理；是否使用由冻结的网络类型决定。 */
  modelProxy: ModelProxySettings | null
  logger: Logger
  signal?: AbortSignal
  limits?: SkillBundleLimits
  maxAttempts?: number
  /** 注入点：单测用假模型，生产用真实 `chat/completions`。 */
  callModel?: (input: ChatCompletionRequest) => Promise<ChatCompletionResult>
}

export interface SkillAiOptimizationOutcome {
  status: 'SUCCEEDED' | 'FAILED'
  uploadId?: string
  changedPaths?: string[]
  errorCode?: string
  /** 实际调用模型的次数（含自检不通过后的重写）。 */
  modelAttempts: number
}

/** 只读一行原因，且截断：错误信息会落库并显示给管理员，不能带正文片段。 */
function reason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const single = raw.replace(/\s+/g, ' ').trim()
  return single.length > 300 ? `${single.slice(0, 300)}…` : single
}

/**
 * 把执行期错误映射成稳定错误码。
 *
 * 分得这么细是有代价的，但混成一个 `SKILL_OPTIMIZATION_FAILED` 的代价更大：管理员看到
 * "优化失败"时唯一想知道的是"该我做什么"——换模型配置、等 Worker 上线、重试、还是这份
 * 技能根本没有可用证据。这四种处置完全不同。
 */
export function classifySkillOptimizationError(error: unknown): string {
  if (error instanceof SkillOptimizationNoChangeError) {
    return SKILL_OPTIMIZATION_ERROR_CODES.NO_CHANGE_NEEDED
  }
  if (error instanceof SkillOptimizationOutputError) {
    return SKILL_OPTIMIZATION_ERROR_CODES.MODEL_OUTPUT_INVALID
  }
  if (error instanceof ModelNetworkRouteError) return error.code
  if (error instanceof ChatCompletionError) return error.code
  if (error instanceof SkillBundleInvalidError || error instanceof SkillBundleLimitError) {
    return SKILL_OPTIMIZATION_ERROR_CODES.REPACK_REJECTED
  }
  const message = error instanceof Error ? error.message : String(error)
  for (const code of [
    'TASK_LEASE_LOST',
    'MODEL_SECRET_MISSING',
    'SKILL_BUNDLE_INVALID',
    'SKILL_BUNDLE_LIMIT_EXCEEDED',
    'SKILL_UPLOAD_INVALID',
    'SKILL_UPLOAD_NOT_FOUND',
    'SKILL_OPTIMIZATION_UPLOAD_INVALID',
  ]) {
    if (message.includes(code)) return code
  }
  return SKILL_OPTIMIZATION_ERROR_CODES.FAILED
}

/**
 * 把解出来的归档变成给模型看的视图。
 *
 * 文本文件严格解码（非法 UTF-8 在这里抛错，而不是静默变成 U+FFFD 再被写回归档）；
 * 图片只留身份 —— 模型不需要、也不可能改它们的字节。
 */
export function toBundleFileViews(
  files: ReadonlyArray<{ path: string; bytes: Buffer }>,
): SkillBundleFileView[] {
  return files.map((file) => {
    const role = roleForPath(file.path)
    return {
      path: file.path,
      text: requiresUtf8(role)
        ? new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)
        : null,
      sizeBytes: file.bytes.length,
      role,
    }
  })
}

/** 未改动文件保持原字节、改写/新增换新内容、删除的去掉。 */
export function repackBundle(
  source: ReadonlyArray<{ path: string; bytes: Buffer }>,
  parsed: ParsedSkillOptimization,
  limits: SkillBundleLimits,
): Buffer {
  const deleted = new Set(parsed.deletedPaths)
  const entries = source
    .filter((file) => !deleted.has(file.path))
    .map((file) => {
      const replacement = parsed.files.get(file.path)
      return replacement === undefined
        ? { path: file.path, bytes: file.bytes }
        : { path: file.path, bytes: Buffer.from(replacement, 'utf8') }
    })
  const existing = new Set(source.map((file) => file.path))
  for (const [path, text] of parsed.files) {
    if (existing.has(path)) continue
    entries.push({ path, bytes: Buffer.from(text, 'utf8') })
  }
  return writeSkillArchive(entries, { compressionRatio: limits.compressionRatio })
}

/**
 * 执行一条已认领的优化任务。
 *
 * 失败一律通过 `submit_skill_ai_optimization_failure` 写回终态 —— 不重排队。模型侧的重试
 * 发生在**这个函数内部**（自检不通过时回灌原因让模型自己改）；把重试放到任务层会让一次
 * 点击变成多条任务，而管理员在页面上只会看到进度条一直转。
 */
export async function runSkillAiOptimization(
  claim: SkillAiOptimizationClaim,
  deps: SkillAiOptimizationDeps,
): Promise<SkillAiOptimizationOutcome> {
  const log = deps.logger.child({
    skill_ai_optimization_id: claim.request_id,
    skill_name: claim.skill_name,
  })
  const limits = deps.limits ?? SKILL_BUNDLE_LIMITS
  const maxAttempts = Math.max(1, deps.maxAttempts ?? MAX_MODEL_ATTEMPTS)
  const claimRef = {
    requestId: claim.request_id,
    workerId: deps.workerId,
    claimToken: claim.claim_token,
  }
  const callModel = deps.callModel ?? requestChatCompletion
  let apiKey: string | null = null
  let attempts = 0

  try {
    const route = resolveModelNetworkRoute({
      mode: claim.network_access_mode_snapshot,
      configuredProxy: deps.modelProxy,
    })

    // 1. 当前发布版本的字节。key 形态由 storage 层再校验一次。
    const archive = await deps.storage.downloadArchive(claim.archive_object_key)
    const source = readSkillArchive(archive, limits)
    const views = toBundleFileViews(source.files)
    if (views.find((file) => file.path === SKILL_ENTRY_FILE)?.text == null) {
      throw new SkillBundleInvalidError(
        `the published bundle has no readable ${SKILL_ENTRY_FILE} to optimize`,
      )
    }

    /*
     * 2. 证据。
     *
     * 门禁是"有几条可学习的评审结论"，不是"被几个 Job 引用过"（V1.22）。线上实测过引用
     * 数为 1、结论数为 0 的技能：旧口径放行，然后把一份全 0 的统计递给模型，模型按"证据
     * 不足别乱改"返回空改动集，解析器判为输出不合规，重试三次全烧掉。
     *
     * `review_result_count` 缺席 = 数据库还没升到 V1.22，此时回退到"结论分布求和"，
     * 口径一致，不需要两端同时发布。
     */
    const evidence: SkillReviewEvidenceSnapshot =
      await deps.jobsDb.getSkillReviewEvidenceForOptimization(claimRef)
    const resultCount =
      typeof evidence.review_result_count === 'number'
        ? evidence.review_result_count
        : Object.values(evidence.verdict_counts ?? {}).reduce(
            (sum, value) => sum + (typeof value === 'number' ? value : 0),
            0,
          )
    if (evidence.referenced_job_count === 0 || resultCount === 0) {
      log.info('skill_ai_optimization_no_evidence', {
        event: 'skill_ai_optimization_no_evidence',
        referenced_job_count: evidence.referenced_job_count,
        review_result_count: resultCount,
      })
      await deps.jobsDb.submitSkillAiOptimizationFailure({
        ...claimRef,
        errorCode: SKILL_OPTIMIZATION_ERROR_CODES.NO_EVIDENCE,
        errorMessage:
          evidence.referenced_job_count === 0
            ? '这个技能没有任何历史评审证据可用'
            : '这个技能被分析任务引用过，但还没有任何评审结论可以作为优化依据',
        modelAttempts: 0,
      })
      return {
        status: 'FAILED',
        errorCode: SKILL_OPTIMIZATION_ERROR_CODES.NO_EVIDENCE,
        modelAttempts: 0,
      }
    }

    // 3. 模型。Key 只存在于这个函数的局部变量里，不进日志、不落盘。
    apiKey = await deps.jobsDb.getModelSecretForSkillAiOptimization(claimRef)

    /*
     * 4～6. 生成 → 解析 → 打包 → **结构自检**，不通过就把原因回灌给模型重写。
     *
     * 自检用的就是人工上传那条路上的 `validateSkillArchive`：frontmatter、角色/扩展名、
     * 图片 magic、严格 UTF-8、路径冲突、容量与压缩比。它对"现在的结构要求"是唯一权威，
     * 所以"AI 改完是否符合现在的结构"这个问题在这里有确定答案，而不是靠提示词自觉。
     */
    let parsed: ParsedSkillOptimization | null = null
    let validated: ValidatedSkillBundle | null = null
    let repacked: Buffer | null = null
    let rejection: string | null = null
    let lastError: unknown = null

    while (attempts < maxAttempts) {
      attempts += 1
      const prompt = buildSkillOptimizationPrompt({
        skillName: claim.skill_name,
        files: views,
        evidence,
        limits,
        previousRejection: rejection,
        attempt: attempts,
        maxAttempts,
      })
      const completion = await callModel({
        baseUrl: claim.base_url_snapshot,
        modelName: claim.model_name_snapshot,
        apiKey,
        systemPrompt: prompt.system,
        userPrompt: prompt.user,
        timeoutMs: claim.request_timeout_ms_snapshot,
        maxTokens: MAX_COMPLETION_TOKENS,
        proxy: route.proxy,
        ...(deps.signal ? { signal: deps.signal } : {}),
      })
      log.info('skill_ai_optimization_model_returned', {
        event: 'skill_ai_optimization_model_returned',
        attempt: attempts,
        latency_ms: completion.latencyMs,
        prompt_tokens: completion.promptTokens,
        completion_tokens: completion.completionTokens,
      })

      try {
        const candidate = parseSkillOptimizationOutput({
          raw: completion.content,
          skillName: claim.skill_name,
          currentFiles: views,
          limits,
        })
        const candidateArchive = repackBundle(source.files, candidate, limits)
        const candidateValidated = validateSkillArchive({
          archive: candidateArchive,
          expectedSkillName: claim.skill_name,
          limits,
        })
        parsed = candidate
        repacked = candidateArchive
        validated = candidateValidated
        break
      } catch (error) {
        if (error instanceof SkillOptimizationNoChangeError) {
          /*
           * 模型走了"不需要改"出口：终态，不重试。
           *
           * 重试没有意义 —— 证据这一轮不会变，同一个模型对同一份证据只会给同一个答案。
           * 这里直接往外抛，由外层 catch 写回 NO_CHANGE_NEEDED 与模型给的理由。
           */
          log.info('skill_ai_optimization_no_change_needed', {
            event: 'skill_ai_optimization_no_change_needed',
            attempt: attempts,
          })
          throw error
        }
        if (
          error instanceof SkillOptimizationOutputError ||
          error instanceof SkillBundleInvalidError ||
          error instanceof SkillBundleLimitError
        ) {
          lastError = error
          rejection = reason(error)
          log.warn('skill_ai_optimization_self_check_rejected', {
            event: 'skill_ai_optimization_self_check_rejected',
            attempt: attempts,
            error_code: classifySkillOptimizationError(error),
          })
          continue
        }
        throw error
      }
    }

    if (parsed === null || repacked === null || validated === null) {
      // 用尽重写次数仍然不合规：终态失败，且**不产出任何草稿**。
      throw lastError ??
        new SkillOptimizationOutputError('the model could not produce a valid bundle')
    }

    // 7. 走既有上传链路。actor 是请求这次优化的管理员，不是 Worker。
    const stagingObjectKey = `staging/${claim.requested_by}/${randomUUID()}.zip`
    const uploadId = await deps.jobsDb.registerSkillUpload({
      actorId: claim.requested_by,
      skillId: claim.skill_id,
      stagingObjectKey,
    })
    try {
      await deps.storage.uploadStagingArchive(stagingObjectKey, repacked)
      await deps.jobsDb.recordSkillUploadValidation({
        actorId: claim.requested_by,
        uploadId,
        archiveSha256: validated.archiveSha256,
        archiveSizeBytes: validated.archiveSizeBytes,
        bundleManifest: validated.manifest,
        expandedSizeBytes: validated.expandedSizeBytes,
        fileCount: validated.fileCount,
        containsScripts: validated.containsScripts,
        entryFrontmatter: validated.frontmatter,
      })
    } catch (error) {
      /*
       * upload 行已经建了但对象或校验落库失败：把失败原因写在那一行上。
       *
       * 不写的话，技能详情页会显示一条永远 PENDING 的"待发布技能包"，而管理员没有任何
       * 线索知道它为什么卡住 —— 那正是 §15 要求"失败也要落库"的原因。
       */
      await deps.jobsDb
        .recordSkillUploadFailure({
          actorId: claim.requested_by,
          uploadId,
          errorCode: classifySkillOptimizationError(error),
          errorMessage: reason(error),
        })
        .catch(() => undefined)
      throw error
    }

    // 8. 写回结果。数据库还会再确认一次 upload 是 VALIDATED 且属于同一技能。
    await deps.jobsDb.submitSkillAiOptimizationResult({
      ...claimRef,
      uploadId,
      changedPaths: parsed.changedPaths,
      aiSummary: parsed.summary,
      modelAttempts: attempts,
    })
    log.info('skill_ai_optimization_succeeded', {
      event: 'skill_ai_optimization_succeeded',
      model_attempts: attempts,
      changed_path_count: parsed.changedPaths.length,
      deleted_path_count: parsed.deletedPaths.length,
      archive_bytes: validated.archiveSizeBytes,
      file_count: validated.fileCount,
      contains_scripts: validated.containsScripts,
    })
    return {
      status: 'SUCCEEDED',
      uploadId,
      changedPaths: parsed.changedPaths,
      modelAttempts: attempts,
    }
  } catch (error) {
    const errorCode = classifySkillOptimizationError(error)
    log.warn('skill_ai_optimization_failed', {
      event: 'skill_ai_optimization_failed',
      error_code: errorCode,
      model_attempts: attempts,
    })
    if (errorCode === 'TASK_LEASE_LOST') {
      // 租约已经不是我们的了，写回只会再撞一次同样的拒绝。
      return { status: 'FAILED', errorCode, modelAttempts: attempts }
    }
    await deps.jobsDb
      .submitSkillAiOptimizationFailure({
        ...claimRef,
        errorCode,
        errorMessage: reason(error),
        modelAttempts: attempts,
      })
      .catch(() => undefined)
    return { status: 'FAILED', errorCode, modelAttempts: attempts }
  } finally {
    apiKey = null
  }
}
