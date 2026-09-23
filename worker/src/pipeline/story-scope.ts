import { createHash } from 'node:crypto'
import { ATTRIBUTION_ALGORITHM_VERSION, attributeStoryCommit, createStoryCandidateManifest, sortStoryCandidates, type IdentityMatchStatus, type StoryCommitAttributionInput, type StoryCommitAttributionResult } from '../analysis/story-commit-attribution.js'
import type { CollectedRepositoryHistory } from '../git/story-history.js'
import type { RepositoryMergeRequestEnrichment } from '../git/gitlab-readonly-client.js'

/**
 * 每个需求每代的候选上限。
 *
 * 与数据库硬约束一致：`analysis_story_scope.candidate_count between 0 and 200`，且
 * `save_analysis_story_scopes` 对超过 200 的候选数组直接抛 `STORY_CANDIDATE_LIMIT_EXCEEDED`。
 * 所以这里必须在发送前截断，而不是让数据库拒绝整批。
 */
const CANDIDATE_LIMIT = 200

/**
 * 没有强/中候选时，允许进池的 WEAK 候选数量上限（V1.11 方案第 481 行的「数量上限」）。
 *
 * 每条进池的 AI_CANDIDATE/WEAK 都是**强制**裁定项：Agent 要读一次 diff 再写一条判定，
 * 否则 `save_agent_review_result` 直接拒绝提交。按每条约 2 次模型/工具往返估算，30 条
 * ≈ 60~90 次往返，在单 attempt 480 次 root 模型请求的预算内还能留出正式评审的余量；
 * 200 条则必然撞预算。要调大先看真实 P95 往返数，不要凭感觉放大。
 */
const WEAK_CANDIDATE_LIMIT = 30

export interface FrozenStoryScopeInput {
  task_id: string
  story_id: string
  story_code: string
  story_name: string
  owners_text: string
  normalized_developer_ids: string[]
  project_name: string | null
  application_name: string | null
  release_window: string | null
  requirement_context: Record<string, unknown>
  input_hash: string
}

export interface FrozenIdentityScopeInput {
  developer_id: string
  display_name: string
  email_fingerprint: string | null
  author_name_aliases: string[]
  verification_status: string
}

export interface StoryScopeWire {
  task_id: string
  generation: number
  scope_mode: 'EXACT_STORY_COMMITS' | 'HYBRID_CANDIDATES' | 'DEVELOPER_WINDOW' | 'REQUIREMENT_REF_ONLY' | 'GLOBAL_FALLBACK'
  status: 'READY' | 'DEGRADED'
  current_scope_level: 'PRIMARY' | 'GLOBAL'
  candidate_manifest_hash: string
  scope_error_code: string | null
  degradation_reasons: string[]
  candidates: Array<{
    candidate_id: string
    repository_name: string
    sha: string
    tier: 'STRONG' | 'AI_CANDIDATE' | 'WEAK' | 'EXCLUDED' | 'CONFLICT'
    selection_source: 'RULE' | 'IDENTITY_WINDOW' | 'FALLBACK'
    rank_score: number
    reason_codes: string[]
    identity_match_type: 'VERIFIED_EMAIL' | 'NAME_ALIAS' | 'NONE' | 'AMBIGUOUS'
    story_match_location: 'COMMIT_TRAILER' | 'COMMIT_SUBJECT' | 'COMMIT_BODY' | 'BRANCH' | 'MR' | 'NONE'
    rule_code: string | null
    effective_status: 'EFFECTIVE' | 'REVERTED' | 'PARTIAL' | 'UNKNOWN'
  }>
}

export interface BuiltStoryScopes {
  algorithmVersion: typeof ATTRIBUTION_ALGORITHM_VERSION
  scopes: StoryScopeWire[]
  scopeCatalogHash: string
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareText(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

function deterministicUuid(parts: readonly string[]): string {
  const hex = createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function identityForCommit(story: FrozenStoryScopeInput, identities: readonly FrozenIdentityScopeInput[], entry: Record<string, unknown>): { status: IdentityMatchStatus; type: StoryScopeWire['candidates'][number]['identity_match_type'] } {
  const owners = new Set(story.normalized_developer_ids)
  const eligible = identities.filter((identity) => owners.has(identity.developer_id) && identity.verification_status === 'VERIFIED')
  const matchStatus = String(entry.author_identity_status ?? 'UNAVAILABLE')
  if (matchStatus === 'CONFLICT') return { status: 'AMBIGUOUS', type: 'AMBIGUOUS' }
  if (matchStatus === 'UNAVAILABLE') return { status: 'UNRESOLVED', type: 'NONE' }
  if (matchStatus === 'MATCHED') {
    const developerId = String(entry.author_developer_id ?? '')
    if (developerId !== '') {
      return owners.has(developerId)
        ? { status: 'VERIFIED', type: 'VERIFIED_EMAIL' }
        : { status: 'UNRESOLVED', type: 'NONE' }
    }
  }
  const fingerprint = String(entry.author_email_fingerprint ?? '')
  const exact = eligible.filter((identity) => identity.email_fingerprint === fingerprint)
  if (exact.length === 1) return { status: 'VERIFIED', type: 'VERIFIED_EMAIL' }
  if (exact.length > 1) return { status: 'AMBIGUOUS', type: 'AMBIGUOUS' }
  // A database-confirmed match to another developer must not be weakened into a name guess.
  if (matchStatus === 'MATCHED') return { status: 'UNRESOLVED', type: 'NONE' }
  const author = String(entry.author_name ?? '').trim().toLowerCase()
  const names = eligible.filter((identity) => identity.display_name.trim().toLowerCase() === author || identity.author_name_aliases.some((alias) => alias.trim().toLowerCase() === author))
  if (names.length === 1) return { status: 'WEAK_NAME', type: 'NAME_ALIAS' }
  if (names.length > 1) return { status: 'AMBIGUOUS', type: 'AMBIGUOUS' }
  return { status: 'UNRESOLVED', type: 'NONE' }
}

/**
 * 模块重合。
 *
 * 需求的项目/应用名里常常带着仓库名本身（实测 `kdmanage下架智能体提供租户影响范围
 * （FT-2026-001591）`）。而这些仓库的提交路径是以仓库名开头的（`kdmanage-backend/...`），
 * 于是 `kdmanage` 这个词会命中该仓库的**每一条**路径，模块重合退化成恒真。
 *
 * 所以：与仓库名重叠的词、纯数字词（`2026` / 单号数字）都不作为模块线索。
 */
function moduleOverlap(story: FrozenStoryScopeInput, entry: Record<string, unknown>, repository: string): boolean {
  const repositoryTokens = new Set(repository.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))
  const needles = [story.project_name, story.application_name]
    .flatMap((value) => String(value ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u))
    .filter((value) => value.length >= 3 && !/^\d+$/.test(value) && !repositoryTokens.has(value))
  if (needles.length === 0) return false
  const files = Array.isArray(entry.files) ? entry.files as Array<Record<string, unknown>> : []
  return files.some((file) => needles.some((needle) => String(file.path ?? '').toLowerCase().includes(needle)))
}

function ruleCode(result: StoryCommitAttributionResult): string | null {
  const reasons = new Set(result.reasonCodes)
  if (reasons.has('EXPLICIT_STORY_ID')) return 'ATTR_EXPLICIT_COMMIT_STORY_ID'
  if (reasons.has('EXPLICIT_MR_STORY_ID')) return 'ATTR_EXPLICIT_MR_STORY_ID'
  if (reasons.has('SAME_EXPLICIT_MR')) return 'ATTR_SAME_EXPLICIT_MR_COMMIT'
  if (reasons.has('REVERT_OF_RELATED_COMMIT')) return 'ATTR_REVERT_CHAIN'
  if (reasons.has('OTHER_STORY_EXPLICIT')) return 'ATTR_OTHER_STORY_EXCLUSION'
  if (reasons.has('STORY_CODE_WITH_SUPPORT')) return 'ATTR_STORY_CODE_WITH_SUPPORT'
  if (reasons.has('OWNER_WINDOW_MODULE')) return 'ATTR_OWNER_WINDOW_MODULE_CANDIDATE'
  if (reasons.has('UNSTRUCTURED_STORY_MENTION')) return 'ATTR_STORY_TEXT_CANDIDATE'
  return null
}

function tier(result: StoryCommitAttributionResult): StoryScopeWire['candidates'][number]['tier'] | null {
  if (result.decision === 'AUTO_SELECTED_EXPLICIT' || result.decision === 'AUTO_SELECTED_STRONG') return 'STRONG'
  if (result.decision === 'AI_RELEVANCE_REQUIRED') return 'AI_CANDIDATE'
  if (result.decision === 'WEAK_FALLBACK') return 'WEAK'
  if (result.decision === 'EXCLUDED') return 'EXCLUDED'
  if (result.decision === 'CONFLICT') return 'CONFLICT'
  return null
}

function isGeneratedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  return /(^|\/)(dist|build|coverage|generated|gen|target\/generated-sources|vendor|node_modules)(\/|$)/.test(normalized)
    || /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock)$/.test(normalized)
    || /(?:\.generated\.|\.g\.|\.designer\.|_generated\.)/.test(normalized)
}

function isMainlyGenerated(entry: Record<string, unknown>): boolean {
  const files = Array.isArray(entry.files) ? entry.files as Array<Record<string, unknown>> : []
  if (files.length === 0) return false
  const generated = files.filter((file) => isGeneratedPath(String(file.path ?? ''))).length
  return generated === files.length || generated * 2 >= files.length
}

function storyLocation(result: StoryCommitAttributionResult): StoryScopeWire['candidates'][number]['story_match_location'] {
  if (result.storyMatches.some((match) => match.location === 'STRUCTURED_MR')) return 'MR'
  if (result.storyMatches.some((match) => match.location === 'STRUCTURED_COMMIT')) return 'COMMIT_TRAILER'
  if (result.storyMatches.some((match) => match.location === 'SOURCE_BRANCH')) return 'BRANCH'
  if (result.storyMatches.some((match) => match.location === 'SUBJECT')) return 'COMMIT_SUBJECT'
  if (result.storyMatches.some((match) => match.location === 'BODY')) return 'COMMIT_BODY'
  return 'NONE'
}

function globalScope(story: FrozenStoryScopeInput, reason: string, generation = 1): StoryScopeWire {
  const manifest = createStoryCandidateManifest(story.story_code, generation, [])
  return {
    task_id: story.task_id,
    generation,
    scope_mode: 'GLOBAL_FALLBACK',
    status: 'DEGRADED',
    current_scope_level: 'GLOBAL',
    candidate_manifest_hash: manifest.manifestHash,
    scope_error_code: reason,
    degradation_reasons: [reason],
    candidates: [],
  }
}

export function buildStoryScopes(input: {
  stories: readonly FrozenStoryScopeInput[]
  identities: readonly FrozenIdentityScopeInput[]
  histories: readonly CollectedRepositoryHistory[]
  mergeRequests?: readonly RepositoryMergeRequestEnrichment[]
  rulesetHash: string
  generation?: number
}): BuiltStoryScopes {
  const generation = input.generation ?? 1
  const incomplete = input.histories.find((history) => history.manifest.enumeration_status !== 'COMPLETE')
  const batchCodes = input.stories.map((story) => story.story_code)
  const mergeRequestsByCommit = new Map<string, RepositoryMergeRequestEnrichment['mergeRequests']>()
  for (const enrichment of input.mergeRequests ?? []) {
    if (enrichment.status !== 'COMPLETE' && enrichment.status !== 'PARTIAL') continue
    for (const mergeRequest of enrichment.mergeRequests) {
      for (const membership of mergeRequest.commits) {
        const key = `${enrichment.repository}:${membership.sha}`
        const current = mergeRequestsByCommit.get(key) ?? []
        if (!current.some((item) => item.merge_request_iid === mergeRequest.merge_request_iid)) {
          mergeRequestsByCommit.set(key, [...current, mergeRequest].sort(
            (left, right) => left.merge_request_iid - right.merge_request_iid,
          ))
        }
      }
    }
  }
  const scopes = input.stories.map((story): StoryScopeWire => {
    if (incomplete) return globalScope(story, `RANGE_${incomplete.manifest.enumeration_status}`, generation)
    type CandidateDescriptor = {
      identityType: StoryScopeWire['candidates'][number]['identity_match_type']
      entry: Record<string, unknown>
      attribution: Omit<StoryCommitAttributionInput, 'revertsRelatedCommit'>
    }
    const descriptors: CandidateDescriptor[] = []
    for (const history of input.histories) {
      for (const entry of history.manifest.commits) {
        const identity = identityForCommit(story, input.identities, entry)
        const candidateId = deterministicUuid([story.task_id, history.manifest.repository, String(entry.sha)])
        const relatedMergeRequests = mergeRequestsByCommit.get(
          `${history.manifest.repository}:${String(entry.sha)}`,
        ) ?? []
        const mrStructuredText = [...new Set(
          relatedMergeRequests.flatMap((mergeRequest) => mergeRequest.structured_story_ids),
        )].sort(compareText).map((code) => `Story-Id: ${code}`).join('\n')
        const sourceBranches = [...new Set(
          relatedMergeRequests.map((mergeRequest) => mergeRequest.source_branch),
        )].sort(compareText).join(' ')
        descriptors.push({
          identityType: identity.type,
          entry,
          attribution: {
            candidateId,
            repository: history.manifest.repository,
            sha: String(entry.sha),
            currentStoryCode: story.story_code,
            batchStoryCodes: batchCodes,
            subject: String(entry.subject ?? ''),
            body: String(entry.message_body ?? ''),
            sourceBranch: sourceBranches || null,
            mrStructuredText: mrStructuredText || null,
            reachableFromFrozenHead: true,
            rangeCompleteness: 'COMPLETE',
            identityStatus: identity.status,
            withinFrozenWindow: true,
            moduleOverlap: moduleOverlap(story, entry, history.manifest.repository),
            sameExplicitMr: relatedMergeRequests.some((mergeRequest) =>
              mergeRequest.structured_story_ids.some(
                (code) => code.trim().toUpperCase() === story.story_code.trim().toUpperCase(),
              ),
            ),
            bot: /\b(bot|automation)\b/i.test(String(entry.author_name ?? '')),
            generated: isMainlyGenerated(entry),
            revertEffect: entry.effective_status === 'REVERTED'
              ? 'FULL'
              : entry.effective_status === 'PARTIAL' ? 'PARTIAL' : 'NONE',
          },
        })
      }
    }

    // Phase 1 deliberately disables the revert-chain shortcut. Only commits
    // independently associated with this Story can become a trusted target.
    const preliminary = descriptors.map((descriptor) => ({
      descriptor,
      result: attributeStoryCommit({ ...descriptor.attribution, revertsRelatedCommit: false }),
    }))
    const relatedCommitKeys = new Set(preliminary
      .filter(({ result }) => result.selected)
      .map(({ descriptor }) => `${descriptor.attribution.repository}:${descriptor.attribution.sha}`))

    // Phase 2 promotes a Revert only when its parsed target is already in the
    // current Story's frozen associated set. A generic/unrelated Revert can no
    // longer manufacture a STRONG candidate merely by being a Revert.
    const attributed = descriptors.map((descriptor) => {
      const revertedSha = typeof descriptor.entry.reverted_sha === 'string'
        ? descriptor.entry.reverted_sha.toLowerCase()
        : ''
      const revertsRelatedCommit = Boolean(descriptor.entry.is_revert)
        && revertedSha !== ''
        && relatedCommitKeys.has(`${descriptor.attribution.repository}:${revertedSha}`)
      return {
        identityType: descriptor.identityType,
        result: attributeStoryCommit({ ...descriptor.attribution, revertsRelatedCommit }),
      }
    })
    const relevant = attributed.filter(({ result }) => tier(result) !== null)
    if (relevant.length === 0) return globalScope(story, 'NO_CANDIDATE', generation)
    /*
     * 候选池的构成必须遵守 V1.11 方案第 397/481 行写下的两条约束：
     *
     *   「`WEAK_FALLBACK` 只在强/中候选为空时进入，按排序和数量上限读取」
     *
     * 实现此前两条都没遵守：WEAK 与 STRONG/AI 一起进池，并共用 200 的大上限。后果是实测
     * 数据（Job `7c46dc97`）里 26 个需求合计需要 **2444** 条 AI 裁定，单个需求最多 200 条，
     * 其中 10 个需求 scope 已经是全仓降级却仍要裁定 156~200 条 —— 既没有收窄范围，又要
     * 为每条候选读一次 diff 再写一条判定（`save_agent_review_result` 会以
     * `ANALYSIS_SCOPE_TRIAGE_INCOMPLETE` 拒绝未裁完的提交），必然撞预算或提交不上去。
     *
     * 所以分三类处理：
     *   * 有 STRONG/AI 候选时，WEAK 一条都不进池 —— 它们不提供证据，只增加裁定成本；
     *   * 没有 STRONG/AI 时，只收「能真正收窄范围」的 WEAK（作者身份已验证，建议
     *     DEVELOPER_WINDOW），并按 WEAK_CANDIDATE_LIMIT 取排序靠前的一批；
     *   * 连这种 WEAK 都没有时，直接全仓降级，且**不存** WEAK 候选：范围已经是全仓，
     *     再要求逐条裁定纯属浪费。
     */
    const auditOnly = relevant
      .filter(({ result }) => tier(result) === 'EXCLUDED' || tier(result) === 'CONFLICT')
      .map(({ result }) => result)
    const strongOrAi = relevant
      .filter(({ result }) => tier(result) === 'STRONG' || tier(result) === 'AI_CANDIDATE')
      .map(({ result }) => result)
    const narrowingWeak = relevant
      .filter(({ result }) => tier(result) === 'WEAK' && result.scopeRecommendation !== 'GLOBAL_FALLBACK')
      .map(({ result }) => result)

    let weakCapped = false
    let pool: StoryCommitAttributionResult[]
    if (strongOrAi.length > 0) {
      pool = [...strongOrAi, ...auditOnly]
    } else if (narrowingWeak.length > 0) {
      const rankedWeak = sortStoryCandidates(narrowingWeak)
      weakCapped = rankedWeak.length > WEAK_CANDIDATE_LIMIT
      pool = [...rankedWeak.slice(0, WEAK_CANDIDATE_LIMIT), ...auditOnly]
    } else {
      return globalScope(story, 'NO_STRONG_SCOPE', generation)
    }

    /*
     * 超出候选上限不再整条降级成全仓分析。
     *
     * 旧行为是 `return globalScope(story, 'STORY_CANDIDATE_LIMIT_EXCEEDED')` —— 把**已经
     * 命中的 STRONG 证据一起扔掉**，换成"请看全仓"，这是最坏的一种降级。现在按优先级
     * （STRONG → AI_CANDIDATE → WEAK → CONFLICT → EXCLUDED，同级按分数）截断到上限，
     * 保留信息量最高的那一批，并把截断如实记为降级原因。
     */
    const ranked = sortStoryCandidates(pool)
    const truncated = ranked.length > CANDIDATE_LIMIT
    const manifest = createStoryCandidateManifest(
      story.story_code,
      generation,
      truncated ? ranked.slice(0, CANDIDATE_LIMIT) : ranked,
    )
    const candidates = manifest.candidates.map((result) => {
      const identityType = relevant.find((item) => item.result.candidateId === result.candidateId)?.identityType ?? 'NONE'
      const candidateTier = tier(result)!
      const candidateRuleCode = ruleCode(result)
      return {
        candidate_id: result.candidateId,
        repository_name: result.repository,
        sha: result.sha,
        tier: candidateTier,
        selection_source: candidateTier === 'WEAK' || candidateRuleCode === null
          ? 'FALLBACK' as const
          : candidateTier === 'AI_CANDIDATE' && result.reasonCodes.includes('OWNER_WINDOW_MODULE')
            ? 'IDENTITY_WINDOW' as const
            : 'RULE' as const,
        rank_score: result.rankScore,
        reason_codes: [...result.reasonCodes],
        identity_match_type: identityType,
        story_match_location: storyLocation(result),
        rule_code: candidateRuleCode,
        effective_status: result.effectiveStatus,
      }
    })
    const strong = candidates.filter((candidate) => candidate.tier === 'STRONG').length
    const ai = candidates.filter((candidate) => candidate.tier === 'AI_CANDIDATE' || candidate.tier === 'WEAK').length
    const recommendation = manifest.candidates.find((candidate) => candidate.selected)?.scopeRecommendation
      ?? manifest.candidates.find((candidate) => candidate.decision === 'AI_RELEVANCE_REQUIRED')?.scopeRecommendation
      // WEAK 自己的建议此前被完全忽略，于是"只有 WEAK"的需求即使已经知道提交属于哪位
      // 负责人（WEAK_FALLBACK 在身份已验证时建议 DEVELOPER_WINDOW），范围仍被判成全仓。
      // 候选都进池了却不用它们收窄范围，是既花钱又没收益的组合。
      ?? manifest.candidates[0]?.scopeRecommendation
      ?? 'GLOBAL_FALLBACK'
    const scopeMode: StoryScopeWire['scope_mode'] = strong > 0 && ai > 0
      ? 'HYBRID_CANDIDATES'
      : recommendation === 'EXACT_STORY_COMMITS' || recommendation === 'DEVELOPER_WINDOW' || recommendation === 'REQUIREMENT_REF_ONLY'
        ? recommendation
        : 'GLOBAL_FALLBACK'
    const degradations = [
      ...(scopeMode === 'GLOBAL_FALLBACK' ? ['NO_STRONG_SCOPE'] : []),
      ...(truncated ? ['STORY_CANDIDATE_LIMIT_TRUNCATED'] : []),
      ...(weakCapped ? ['WEAK_CANDIDATES_CAPPED'] : []),
    ]
    return {
      task_id: story.task_id,
      generation,
      scope_mode: scopeMode,
      status: degradations.length > 0 ? 'DEGRADED' : 'READY',
      current_scope_level: scopeMode === 'GLOBAL_FALLBACK' ? 'GLOBAL' : 'PRIMARY',
      candidate_manifest_hash: manifest.manifestHash,
      scope_error_code: degradations[0] ?? null,
      degradation_reasons: degradations,
      candidates,
    }
  })
  const identity = {
    algorithmVersion: ATTRIBUTION_ALGORITHM_VERSION,
    generation,
    rulesetHash: input.rulesetHash,
    stories: input.stories.map((story) => ({ taskId: story.task_id, inputHash: story.input_hash })).sort((a, b) => compareText(a.taskId, b.taskId)),
    scopes: scopes.map((scope) => ({ taskId: scope.task_id, manifestHash: scope.candidate_manifest_hash })).sort((a, b) => compareText(a.taskId, b.taskId)),
  }
  return {
    algorithmVersion: ATTRIBUTION_ALGORITHM_VERSION,
    scopes,
    scopeCatalogHash: `sha256:${createHash('sha256').update(`story-scope-catalog-v1\n${stableJson(identity)}\n`, 'utf8').digest('hex')}`,
  }
}
