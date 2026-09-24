/**
 * Linky 取数接口的**纯**映射层（V1.20）。
 *
 * 这里只做"上游 JSON → 平台结构化字段"，不发请求、不碰数据库，所以可以整段单测。
 * 六条规则全部来自 2026-09-24 对真实接口的实测，不是照文档推断的：
 *
 *   1. 需求正文不在 `description` 里 —— 实测多条故事该字段恒为空字符串，
 *      正文在 `field_values.gf_description`；标题另有 `field_values.gf_name`。
 *   2. 迭代 / 发布窗口的**可读名只有列表端点给**，详情里只有 `tf_iteration` /
 *      `tf_release_window` 的 UUID。所以镜像里这两列只能来自列表项。
 *   3. 详情的 `status` 是内部码（实测 `te3L3uJF`），可读值在 `status_label`；
 *      列表的 `status` 本身就是可读值。
 *   4. 详情的 `attachments` 在无附件时是 `null`，附件一律走 `/attachments` 端点。
 *   5. `download_url` 直连返回 401，必须走 `/attachments/{id}/download`；
 *      附件列表里的 `content_type` 与下载响应头会不一致（`.docx` 列表写
 *      `application/zip`），以下载响应头为准。
 *   6. `team` 为 null 时 `team_resolve_error` 说明原因 —— 此时一个人名都不许编。
 */

export interface LinkyStoryListItemWire {
  id?: unknown
  code?: unknown
  title?: unknown
  status?: unknown
  assignee?: unknown
  iteration?: unknown
  release_window?: unknown
  subject?: unknown
  workspace_id?: unknown
  workspace_name?: unknown
}

export interface LinkyStoryListPage {
  items: LinkyStoryListItemWire[]
  total: number
  page: number
  pageSize: number
  scopes: number
}

export interface LinkyAttachmentWire {
  id?: unknown
  filename?: unknown
  content_type?: unknown
  size_bytes?: unknown
}

export interface CatalogItemPayload {
  issue_id: string
  story_code: string
  title: string
  workspace_id: string
  workspace_name: string
  status_label: string | null
  assignee_name: string | null
  iteration: string | null
  release_window: string | null
  subject_name: string | null
  story_url: string | null
  list_item: Record<string, unknown>
}

export interface CatalogDetailPayload {
  requirement_detail: string | null
  team: Record<string, unknown> | null
  team_resolve_error: string | null
  field_values: Record<string, unknown>
  story_url: string | null
}

export interface CatalogAttachmentPayload {
  linky_attachment_id: string
  filename: string
  content_type: string | null
  size_bytes: string | null
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Linky 的 web 地址由部署侧配置；没配就不产出链接，绝不猜一个 URL 出来。 */
export function buildStoryUrl(
  webBaseUrl: string | null,
  workspaceId: string,
  issueId: string,
): string | null {
  if (webBaseUrl === null) return null
  const base = webBaseUrl.replace(/\/+$/, '')
  return `${base}/workspaces/${workspaceId}/issues/${issueId}`
}

/** 列表项 → 镜像行。缺少三个必要标识（issue_id / code / workspace_id）的条目返回 null。 */
export function toCatalogItemPayload(
  raw: LinkyStoryListItemWire,
  options: { webBaseUrl?: string | null } = {},
): CatalogItemPayload | null {
  const issueId = str(raw.id)
  const storyCode = str(raw.code)
  const workspaceId = str(raw.workspace_id)
  if (issueId === null || storyCode === null || workspaceId === null) return null
  if (!UUID_RE.test(issueId) || !UUID_RE.test(workspaceId)) return null
  return {
    issue_id: issueId,
    story_code: storyCode,
    title: str(raw.title) ?? storyCode,
    workspace_id: workspaceId,
    workspace_name: str(raw.workspace_name) ?? '',
    status_label: str(raw.status),
    assignee_name: str(raw.assignee),
    iteration: str(raw.iteration),
    release_window: str(raw.release_window),
    subject_name: str(raw.subject),
    story_url: buildStoryUrl(options.webBaseUrl ?? null, workspaceId, issueId),
    list_item: raw as Record<string, unknown>,
  }
}

/**
 * 详情 → 镜像行的正文/负责人部分。
 *
 * `gf_description` 优先于 `description`：实测 `description` 恒空。两个都空就是 null ——
 * 导入 RPC 会以 LINKY_DETAIL_NOT_SYNCED 拒绝这种故事，而不是让 AI 拿空需求去评审。
 */
export function toCatalogDetailPayload(
  detail: Record<string, unknown>,
  options: { webBaseUrl?: string | null } = {},
): CatalogDetailPayload {
  const fieldValues =
    typeof detail.field_values === 'object' && detail.field_values !== null
      ? (detail.field_values as Record<string, unknown>)
      : {}
  const teamRaw = detail.team
  const team =
    typeof teamRaw === 'object' && teamRaw !== null && !Array.isArray(teamRaw)
      ? (teamRaw as Record<string, unknown>)
      : null
  const issueId = str(detail.id)
  const workspaceId = str(detail.workspace_id)
  return {
    requirement_detail: str(fieldValues.gf_description) ?? str(detail.description),
    team,
    team_resolve_error: str(detail.team_resolve_error),
    field_values: fieldValues,
    story_url:
      issueId !== null && workspaceId !== null
        ? buildStoryUrl(options.webBaseUrl ?? null, workspaceId, issueId)
        : null,
  }
}

export function toAttachmentPayloads(items: LinkyAttachmentWire[]): CatalogAttachmentPayload[] {
  const seen = new Set<string>()
  const result: CatalogAttachmentPayload[] = []
  for (const item of items) {
    const id = str(item.id)
    const filename = str(item.filename)
    if (id === null || filename === null || seen.has(id)) continue
    seen.add(id)
    const size = typeof item.size_bytes === 'number' && Number.isFinite(item.size_bytes)
      ? String(Math.max(0, Math.trunc(item.size_bytes)))
      : null
    result.push({
      linky_attachment_id: id,
      filename,
      content_type: str(item.content_type),
      size_bytes: size,
    })
  }
  return result
}

/**
 * 允许入库的附件类型。
 *
 * 白名单而不是黑名单：附件是**外部不可信输入**，会被写进 attempt workspace 让 Agent 读。
 * 可执行体、脚本归档、`.svg`（浏览器打开即执行脚本）一律不收。
 */
export const ATTACHMENT_EXTENSION_ALLOWLIST = new Set([
  'md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml',
  'html', 'htm', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
])

export function attachmentExtension(filename: string): string | null {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(filename.trim())
  return match === null ? null : match[1].toLowerCase()
}

export function isAllowedAttachment(filename: string): boolean {
  const ext = attachmentExtension(filename)
  return ext !== null && ATTACHMENT_EXTENSION_ALLOWLIST.has(ext)
}

/**
 * 落盘用的安全文件名。
 *
 * 拒绝而不是"清洗成某个凑合的名字"的情况：空名、`.`、`..`。其余把路径分隔符、
 * 控制字符、Windows 保留字符换成下划线，长度截到 120 —— 中文名保留原样，
 * 因为 Agent 读到的目录里应该是人看得懂的文件名。
 */
export function sanitizeAttachmentFileName(filename: string): string {
  const base = filename.trim().replace(/^.*[/\\]/, '')
  if (base === '' || base === '.' || base === '..') {
    throw new Error('LINKY_ATTACHMENT_FILENAME_INVALID')
  }
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, '_').replace(/\s+/g, ' ').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    throw new Error('LINKY_ATTACHMENT_FILENAME_INVALID')
  }
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned
}

/**
 * 镜像层对象 key。
 *
 * 刻意只用 ASCII：`catalog/<workspace_id>/<attachment_id>.<ext>`。真实文件名存在
 * 数据库的 `filename` 列里，物化到 workspace 时才用它命名 —— 对象 key 里不放
 * 用户可控的字符串，就没有"key 里出现 `..` 或换行"这条路径。
 */
export function catalogAttachmentObjectKey(
  workspaceId: string,
  attachmentId: string,
  filename: string,
): string {
  if (!UUID_RE.test(workspaceId)) throw new Error('LINKY_WORKSPACE_ID_INVALID')
  const safeId = attachmentId.trim().toLowerCase()
  // 上游的附件 id 既有 UUID，也有文档示例里的 `att-1` 这种短 id，所以不能按长度卡；
  // 但只允许 [0-9a-z-]，于是 key 里不可能出现 `/`、`..` 或换行。
  if (!/^[0-9a-z][0-9a-z-]{0,63}$/.test(safeId)) throw new Error('LINKY_ATTACHMENT_ID_INVALID')
  const ext = attachmentExtension(filename)
  return `catalog/${workspaceId.toLowerCase()}/${safeId}${ext === null ? '' : `.${ext}`}`
}

const CATALOG_KEY_RE = /^catalog\/[0-9a-f-]{36}\/[0-9a-z][0-9a-z-]{0,63}(\.[a-z0-9]{1,12})?$/

/** 下载前再校验一次形状：冻结值本该可信，但"本该可信"不是不检查的理由。 */
export function assertCatalogAttachmentKey(objectKey: string): string {
  if (!CATALOG_KEY_RE.test(objectKey)) {
    throw new Error('LINKY_ATTACHMENT_KEY_INVALID')
  }
  return objectKey
}
