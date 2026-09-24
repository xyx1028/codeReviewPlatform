/**
 * 技能 AI 优化的执行体（V1.19）。
 *
 * 它做的事只有一件：**替管理员预先填好一次 ZIP 上传**。
 *
 * ```text
 * 下载当前发布版本 ZIP → 解包取白名单文本 → 读历史评审证据 → 调一次模型
 *   → fail-closed 解析输出 → 未改动文件保持原字节、改动文件换新内容重新打包
 *   → 走既有的 admin_register_skill_upload + admin_record_skill_upload_validation
 *   → submit_skill_ai_optimization_result
 * ```
 *
 * 三条边界写在代码结构里，不只写在注释里：
 *
 *   1. **不发布。** 这个模块没有任何调用 `admin_publish_review_skill_version` 的路径。
 *      发布只能由管理员在看完 diff 之后手动触发。
 *   2. **不绕校验。** 打包产物被当成一份陌生上传重新跑 `validateSkillArchive`，然后把结果
 *      交给与人工上传**同一个** RPC 落库。任何一项不合规都变成终态 FAILED，不产出草稿。
 *   3. **未改动文件字节级不变。** 重新打包用的是原归档解出来的 Buffer，不做任何再编码。
 *      图片、脚本这类非文本文件因此不可能被 AI 间接改动。
 */

import { randomUUID } from 'node:crypto'

import {
  SkillBundleInvalidError,
  SkillBundleLimitError,
  validateSkillArchive,
} from './bundle-validator.js'
import { SKILL_BUNDLE_LIMITS, type SkillBundleLimits } from './skill-limits.js'
import { requiresUtf8, roleForPath, SKILL_ENTRY_FILE } from './skill-manifest.js'
import {
  buildSkillOptimizationPrompt,
  OPTIMIZABLE_PATHS,
  parseSkillOptimizationOutput,
  SkillOptimizationOutputError,
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

/** 输出上限。`SKILL.md` 的字节上限是 64 KiB，按最坏情况 1 token ≈ 2 字节留足余量。 */
const MAX_COMPLETION_TOKENS = 40000

export const SKILL_OPTIMIZATION_ERROR_CODES = {
  ARCHIVE_UNREADABLE: 'SKILL_OPTIMIZATION_SOURCE_UNREADABLE',
  NO_EVIDENCE: 'SKILL_OPTIMIZATION_NO_EVIDENCE',
  MODEL_OUTPUT_INVALID: 'SKILL_OPTIMIZATION_MODEL_OUTPUT_INVALID',
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
  /** 注入点：单测用假模型，生产用真实 `chat/completions`。 */
  callModel?: (input: ChatCompletionRequest) => Promise<ChatCompletionResult>
}

export interface SkillAiOptimizationOutcome {
  status: 'SUCCEEDED' | 'FAILED'
  uploadId?: string
  changedPaths?: string[]
  errorCode?: string
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

/** 解出白名单内的文本文件正文。非文本角色一律不解码（它们也不允许被改）。 */
export function readOptimizableText(
  files: ReadonlyArray<{ path: string; bytes: Buffer }>,
): Map<string, string> {
  const texts = new Map<string, string>()
  for (const file of files) {
    if (!OPTIMIZABLE_PATHS.includes(file.path)) continue
    if (!requiresUtf8(roleForPath(file.path))) continue
    // 严格解码：非法 UTF-8 在这里抛错，而不是静默变成 U+FFFD 再被写回归档。
    texts.set(file.path, new TextDecoder('utf-8', { fatal: true }).decode(file.bytes))
  }
  return texts
}

/**
 * 执行一条已认领的优化任务。
 *
 * 失败一律通过 `submit_skill_ai_optimization_failure` 写回终态 —— 不重排队。这类任务是
 * 管理员手动触发的一次性动作，"悄悄重试三次"会把一次点击变成三次模型费用，而他在页面上
 * 只会看到进度条一直转。
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
  const claimRef = {
    requestId: claim.request_id,
    workerId: deps.workerId,
    claimToken: claim.claim_token,
  }
  const callModel = deps.callModel ?? requestChatCompletion
  let apiKey: string | null = null

  try {
    const route = resolveModelNetworkRoute({
      mode: claim.network_access_mode_snapshot,
      configuredProxy: deps.modelProxy,
    })

    // 1. 当前发布版本的字节。key 形态由 storage 层再校验一次。
    const archive = await deps.storage.downloadArchive(claim.archive_object_key)
    const source = readSkillArchive(archive, limits)
    const currentFiles = readOptimizableText(source.files)
    if (!currentFiles.has(SKILL_ENTRY_FILE)) {
      throw new SkillBundleInvalidError(
        `the published bundle has no readable ${SKILL_ENTRY_FILE} to optimize`,
      )
    }

    // 2. 证据。空证据在入队时已被拒，这里是二次确认（技能可能在排队期间被清空引用）。
    const evidence: SkillReviewEvidenceSnapshot =
      await deps.jobsDb.getSkillReviewEvidenceForOptimization(claimRef)
    if (evidence.referenced_job_count === 0) {
      await deps.jobsDb.submitSkillAiOptimizationFailure({
        ...claimRef,
        errorCode: SKILL_OPTIMIZATION_ERROR_CODES.NO_EVIDENCE,
        errorMessage: '这个技能没有任何历史评审证据可用',
      })
      return { status: 'FAILED', errorCode: SKILL_OPTIMIZATION_ERROR_CODES.NO_EVIDENCE }
    }

    // 3. 模型。Key 只存在于这个函数的局部变量里，不进日志、不落盘。
    apiKey = await deps.jobsDb.getModelSecretForSkillAiOptimization(claimRef)
    const prompt = buildSkillOptimizationPrompt({
      skillName: claim.skill_name,
      currentFiles,
      evidence,
      entryFileBytes: limits.entryFileBytes,
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
      latency_ms: completion.latencyMs,
      prompt_tokens: completion.promptTokens,
      completion_tokens: completion.completionTokens,
    })

    // 4. fail-closed 解析。
    const parsed = parseSkillOptimizationOutput({
      raw: completion.content,
      skillName: claim.skill_name,
      currentFiles,
      entryFileBytes: limits.entryFileBytes,
    })
    const changedPaths = [...parsed.files.keys()].sort()

    // 5. 重新打包：只换改动文件，其余保持原字节。
    const repacked = writeSkillArchive(
      source.files.map((file) => {
        const replacement = parsed.files.get(file.path)
        return replacement === undefined
          ? { path: file.path, bytes: file.bytes }
          : { path: file.path, bytes: Buffer.from(replacement, 'utf8') }
      }),
      { compressionRatio: limits.compressionRatio },
    )

    /*
     * 6. 把产物当成一份陌生上传重新校验。
     *
     * 顺序是刻意的：校验的对象必须是**最终要发布的那一串字节**，而不是打包前的内存结构。
     * 这一步同时也是对我们自己的打包器的检查 —— 它写出一份解析器不接受的归档时，
     * 这里会以 REPACK_REJECTED 失败，而不是让一份坏归档进 staging。
     */
    const validated = validateSkillArchive({
      archive: repacked,
      expectedSkillName: claim.skill_name,
      limits,
    })

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
      changedPaths,
      aiSummary: parsed.summary,
    })
    log.info('skill_ai_optimization_succeeded', {
      event: 'skill_ai_optimization_succeeded',
      changed_path_count: changedPaths.length,
      archive_bytes: validated.archiveSizeBytes,
      file_count: validated.fileCount,
    })
    return { status: 'SUCCEEDED', uploadId, changedPaths }
  } catch (error) {
    const errorCode = classifySkillOptimizationError(error)
    log.warn('skill_ai_optimization_failed', {
      event: 'skill_ai_optimization_failed',
      error_code: errorCode,
    })
    if (errorCode === 'TASK_LEASE_LOST') {
      // 租约已经不是我们的了，写回只会再撞一次同样的拒绝。
      return { status: 'FAILED', errorCode }
    }
    await deps.jobsDb
      .submitSkillAiOptimizationFailure({ ...claimRef, errorCode, errorMessage: reason(error) })
      .catch(() => undefined)
    return { status: 'FAILED', errorCode }
  } finally {
    apiKey = null
  }
}
