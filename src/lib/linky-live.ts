/**
 * 浏览器直连 Linky 取数接口（V1.20 修订）。
 *
 * 为什么前端直连：需求在 Linky 那边随时在改，看板要的是**现在**的样子。走平台镜像就必然
 * 有一个"上次同步到什么时候"的中间状态，而那个状态本身就是误导。接口 CORS 全开
 * （实测回显任意 Origin），所以浏览器可以直接读。
 *
 * 代价写在类型上：这个接口只在公司内网/VPN 可达（域名在内网 DNS 下解析到 172.18.x.x），
 * 所以拿不到数据时必须明确告诉用户"你不在内网"，而不是显示一个空列表假装没有需求。
 *
 * 这里**只读**。把需求落进批次是另一条路径（`request_linky_batch_import` → Worker 在内网
 * 侧取数并冻结），原因是：让浏览器提供"需求正文"这一评审输入，平台无从判断它是否真的
 * 来自 Linky。
 */

const DEFAULT_BASE = 'https://feature.kingdee.com:2055/quality-platform/api/linky'

export function linkyApiBase(): string {
  const configured = import.meta.env.VITE_LINKY_API_BASE_URL as string | undefined
  return (configured && configured.trim() !== '' ? configured : DEFAULT_BASE).replace(/\/+$/, '')
}

export interface LinkyLiveStory {
  issueId: string
  storyCode: string
  title: string
  workspaceId: string
  workspaceName: string
  statusLabel: string | null
  assigneeName: string | null
  iteration: string | null
  releaseWindow: string | null
  subjectName: string | null
}

export interface LinkyLiveTeamMember {
  id: string | null
  name: string
}

export interface LinkyLiveDetail {
  storyCode: string
  requirementDetail: string | null
  team: { req: LinkyLiveTeamMember[]; dev: LinkyLiveTeamMember[]; test: LinkyLiveTeamMember[] } | null
  teamResolveError: string | null
}

export interface LinkyLiveAttachment {
  id: string
  filename: string
  contentType: string | null
  sizeBytes: number | null
  downloadUrl: string
}

export type LinkyLiveErrorKind = 'NETWORK' | 'NOT_FOUND' | 'HTTP' | 'PARSE'

export class LinkyLiveError extends Error {
  readonly kind: LinkyLiveErrorKind

  constructor(message: string, kind: LinkyLiveErrorKind) {
    super(message)
    this.name = 'LinkyLiveError'
    this.kind = kind
  }
}

const UNREACHABLE =
  'Linky 取数接口连不上。它只在公司内网可达，请确认已连上公司网络或 VPN（页面本身不需要内网）。'

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  } catch {
    // fetch 只在网络层失败时 reject；CORS 被拒也走这里。两种情况对用户是同一句话。
    throw new LinkyLiveError(UNREACHABLE, 'NETWORK')
  }
  if (response.status === 404) {
    throw new LinkyLiveError('Linky 里找不到这条需求或附件。', 'NOT_FOUND')
  }
  if (!response.ok) {
    throw new LinkyLiveError(`Linky 返回 HTTP ${response.status}`, 'HTTP')
  }
  try {
    return await response.json()
  } catch {
    throw new LinkyLiveError('Linky 返回的不是合法 JSON', 'PARSE')
  }
}

function toStory(raw: Record<string, unknown>): LinkyLiveStory | null {
  const issueId = text(raw.id)
  const storyCode = text(raw.code)
  const workspaceId = text(raw.workspace_id)
  if (issueId === null || storyCode === null || workspaceId === null) return null
  return {
    issueId,
    storyCode,
    title: text(raw.title) ?? storyCode,
    workspaceId,
    workspaceName: text(raw.workspace_name) ?? '',
    statusLabel: text(raw.status),
    assigneeName: text(raw.assignee),
    iteration: text(raw.iteration),
    releaseWindow: text(raw.release_window),
    subjectName: text(raw.subject),
  }
}

/**
 * 拉一个范围内的全部故事。
 *
 * 不带工作区就是跨全部启用工作区汇总 —— 项目组下拉只能这么得到，因为接口没有
 * "列出工作区"的端点。`maxPages` 是安全阀：上游 total 与实际条数不一致时得有地方停下。
 */
export async function fetchLinkyStories(
  options: { workspaceName?: string | null; signal?: AbortSignal; maxPages?: number } = {},
): Promise<{ stories: LinkyLiveStory[]; total: number; scopes: number }> {
  const base = linkyApiBase()
  const maxPages = Math.max(options.maxPages ?? 12, 1)
  const collected: LinkyLiveStory[] = []
  let total = 0
  let scopes = 1
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`${base}/stories`)
    url.searchParams.set('page', String(page))
    url.searchParams.set('page_size', '200')
    if (options.workspaceName) url.searchParams.set('workspace_name', options.workspaceName)
    const payload = await getJson(url.toString(), options.signal)
    if (typeof payload !== 'object' || payload === null) {
      throw new LinkyLiveError('Linky 列表响应不是对象', 'PARSE')
    }
    const record = payload as Record<string, unknown>
    const items = Array.isArray(record.items) ? record.items : []
    total = typeof record.total === 'number' ? record.total : items.length
    scopes = typeof record.scopes === 'number' ? record.scopes : 1
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      const story = toStory(item as Record<string, unknown>)
      if (story !== null) collected.push(story)
    }
    if (items.length === 0 || collected.length >= total) break
  }
  return { stories: collected, total, scopes }
}

export async function fetchLinkyStoryDetail(
  storyCode: string,
  signal?: AbortSignal,
): Promise<LinkyLiveDetail> {
  const payload = await getJson(
    `${linkyApiBase()}/stories/${encodeURIComponent(storyCode)}`,
    signal,
  )
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const fieldValues = (typeof record.field_values === 'object' && record.field_values !== null
    ? record.field_values
    : {}) as Record<string, unknown>
  const rawTeam = record.team
  const team =
    typeof rawTeam === 'object' && rawTeam !== null && !Array.isArray(rawTeam)
      ? (rawTeam as Record<string, unknown>)
      : null
  const members = (role: string): LinkyLiveTeamMember[] => {
    const list = team?.[role]
    if (!Array.isArray(list)) return []
    return list.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const name = text((entry as Record<string, unknown>).name)
      if (name === null) return []
      return [{ id: text((entry as Record<string, unknown>).id), name }]
    })
  }
  return {
    storyCode,
    // 实测上游 description 恒为空，正文在 field_values.gf_description。
    requirementDetail: text(fieldValues.gf_description) ?? text(record.description),
    team: team === null ? null : { req: members('req'), dev: members('dev'), test: members('test') },
    teamResolveError: text(record.team_resolve_error),
  }
}

export async function fetchLinkyAttachments(
  storyCode: string,
  signal?: AbortSignal,
): Promise<LinkyLiveAttachment[]> {
  const payload = await getJson(
    `${linkyApiBase()}/stories/${encodeURIComponent(storyCode)}/attachments`,
    signal,
  )
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const items = Array.isArray(record.items) ? record.items : []
  const seen = new Set<string>()
  const result: LinkyLiveAttachment[] = []
  for (const entry of items) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    const id = text(item.id)
    const filename = text(item.filename)
    if (id === null || filename === null || seen.has(id)) continue
    seen.add(id)
    result.push({
      id,
      filename,
      contentType: text(item.content_type),
      sizeBytes: typeof item.size_bytes === 'number' ? item.size_bytes : null,
      // 刻意用平台的下载端点而不是上游返回的 download_url：后者实测直连返回 401。
      downloadUrl: `${linkyApiBase()}/stories/${encodeURIComponent(storyCode)}/attachments/${encodeURIComponent(id)}/download`,
    })
  }
  return result
}

export function describeLinkyLiveError(error: unknown): string {
  if (error instanceof LinkyLiveError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
