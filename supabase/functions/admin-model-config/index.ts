// supabase/functions/admin-model-config/index.ts
//
// 管理模型配置的短请求 Edge Function。
// 职责：
//   * 严格校验调用者为已登录的 ADMIN。
//   * create / update：向 Supabase Vault 写入或轮换 API Key，ai_model_config 只保存 secret UUID。
//   * test：对模型接口发起最小连通性测试，不携带任何代码或需求。
// 安全约束：
//   * 绝不在日志中输出 API Key、Authorization Header、请求体或 Vault secret 明文。
//   * 响应体绝不返回 api_key_secret_id 或 API Key。
//   * 轮换密钥时：先创建新 secret，更新引用成功后再删除旧 secret。
//
// 依赖数据库函数（0020 迁移）：
//   admin_create_model_config / admin_update_model_config /
//   admin_set_model_enabled / admin_get_model_secret_by_config。
// 这些函数仅授权 service_role，本函数使用 SERVICE_ROLE key 调用。
//
// 重要：service_role 调用没有 auth.uid()，因此凡是需要判断"谁在操作"的 RPC 都
// 必须显式接收 p_actor_id，由函数内 assert_actor_is_admin(p_actor_id) 校验。
// 依赖 ensure_admin() 的写法在这条路径上必然失败（0018 修的就是这个）。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// CORS 白名单：ALLOWED_ORIGINS 逗号分隔；始终兼容本地开发端口。绝不通配 '*'。
const LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]

function allowedOrigins(): string[] {
  const raw = Deno.env.get('ALLOWED_ORIGINS') ?? ''
  const configured = raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o.length > 0)
  return Array.from(new Set([...configured, ...LOCAL_ORIGINS]))
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = (req.headers.get('Origin') ?? '').replace(/\/+$/, '')
  const list = allowedOrigins()
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
  if (origin && list.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

/**
 * Harness 的 token 窗口配置。
 *
 * 请求次数预算（agent_max_*_requests）刻意不在这里：它们与「默认能力策略」页写的是
 * ai_model_config 的同一批列，两个写入口会互相覆盖，且策略页那条路径才带预算一致性
 * 校验与审计。本函数不再接收也不再转发这些字段。
 */
interface AgentSettings {
  context_window?: number
  max_output_tokens?: number
}

interface CreatePayload extends AgentSettings {
  action: 'create'
  display_name: string
  base_url: string
  model_name: string
  api_key: string
  max_parallel_tasks?: number
  request_timeout_ms?: number
}

interface UpdatePayload extends AgentSettings {
  action: 'update'
  id: string
  display_name?: string
  base_url?: string
  model_name?: string
  // 留空表示不轮换密钥
  api_key?: string
  max_parallel_tasks?: number
  request_timeout_ms?: number
}

interface DeletePayload {
  action: 'delete'
  id: string
}

interface TestPayload {
  action: 'test'
  // 使用现有配置 id 测试，或直接传入临时凭据测试
  id?: string
  base_url?: string
  model_name?: string
  api_key?: string
}

type Payload = CreatePayload | UpdatePayload | DeletePayload | TestPayload

// 请求作用域 CORS 头（在 Deno.serve 入口按 Origin 计算后设置）。
let CURRENT_CORS: Record<string, string> = {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CURRENT_CORS, 'Content-Type': 'application/json' },
  })
}

/**
 * 提取可回给管理员看的单行原因。
 *
 * 这个端点只有 ADMIN 能调用，而这里的错误信息几乎全部来自我们自己写的
 * raise exception（例如 'ADMIN role required'、'invalid provider'）。
 * 把它们统一压成通用文案会让线上故障无法诊断，所以透传 message；但只透传
 * message，不带 details/hint，避免把 SQL 片段或行数据带出去。
 */
function reason(error: unknown): string | undefined {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : typeof error === 'string'
        ? error
        : ''
  const single = message.replace(/\s+/g, ' ').trim()
  if (single === '') return undefined
  return single.length > 300 ? `${single.slice(0, 300)}…` : single
}

/** 拼接"操作失败 + 具体原因"，原因缺失时退回操作描述。 */
function failure(what: string, error: unknown): string {
  const why = reason(error)
  return why ? `${what}: ${why}` : what
}

// 安全日志：仅记录事件与非敏感字段，绝不含密钥/请求体。
function logEvent(event: string, meta: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (/key|secret|token|authorization|password/i.test(k)) continue
    safe[k] = v
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), fn: 'admin-model-config', event, ...safe }))
}

function serviceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// 校验调用者为已登录 ADMIN，返回其 user id。
async function requireAdmin(req: Request): Promise<{ userId: string } | Response> {
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'missing bearer token' }, 401)
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: userData, error: userErr } = await userClient.auth.getUser()
  if (userErr || !userData?.user) {
    return json({ error: 'invalid session' }, 401)
  }

  // 用服务角色查询角色，避免依赖 RLS 细节。
  const svc = serviceClient()
  const { data: profile, error: profErr } = await svc
    .from('user_profile')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle()

  if (profErr || !profile || profile.role !== 'ADMIN') {
    return json({ error: 'ADMIN role required' }, 403)
  }

  return { userId: userData.user.id }
}

// 在 Vault 创建 secret，返回 secret UUID。使用完毕后清空局部明文引用。
// 通过 public.admin_vault_create_secret 包装（仅 service_role），
// 避免依赖 PostgREST 暴露 vault schema。
async function createVaultSecret(svc: ReturnType<typeof serviceClient>, secret: string, name: string): Promise<string> {
  const { data, error } = await svc.rpc('admin_vault_create_secret', {
    p_secret: secret,
    p_name: name,
  })
  // 这里刻意不透传数据库原因：唯一入参就是 API Key 明文，任何回显路径都可能把它
  // 带出去。其余分支都透传原因（见 reason()），这一条是有意的例外，勿"顺手统一"。
  if (error) throw new Error('vault secret creation failed')
  return data as string
}

async function deleteVaultSecret(
  svc: ReturnType<typeof serviceClient>,
  secretId: string,
): Promise<boolean> {
  // 数据库元数据已提交后尽力清理 secret；失败仅告警，由后台巡检补偿。
  const { data, error } = await svc.rpc('admin_vault_delete_secret', { p_secret_id: secretId })
  if (error || data !== true) {
    logEvent('old_secret_cleanup_failed', { secret_present: true })
    return false
  }
  return true
}

async function handleCreate(userId: string, p: CreatePayload): Promise<Response> {
  if (!p.display_name || !p.base_url || !p.model_name || !p.api_key) {
    return json({ error: 'display_name, base_url, model_name, api_key are required' }, 400)
  }
  const svc = serviceClient()
  let apiKey: string | null = p.api_key
  const secretName = `ai_model_${crypto.randomUUID()}`

  let secretId: string
  try {
    secretId = await createVaultSecret(svc, apiKey, secretName)
  } finally {
    apiKey = null // 清空局部明文引用
  }

  const { data: newId, error } = await svc.rpc('admin_create_model_config', {
    p_actor_id: userId,
    p_display_name: p.display_name,
    p_base_url: p.base_url,
    p_model_name: p.model_name,
    p_api_key_secret_id: secretId,
    p_max_parallel_tasks: p.max_parallel_tasks ?? 4,
    p_request_timeout_ms: p.request_timeout_ms ?? 180000,
    p_context_window: p.context_window ?? 131072,
    p_max_output_tokens: p.max_output_tokens ?? 8192,
    // agent_max_*_requests 不传：让 RPC 的列默认值生效，之后由「默认能力策略」页调整。
  })

  if (error) {
    // 元数据写入失败，回收刚创建的 secret 避免悬挂
    await deleteVaultSecret(svc, secretId)
    logEvent('create_failed', { userId, reason: reason(error) })
    return json({ error: failure('failed to create model config', error) }, 400)
  }

  logEvent('created', {
    userId,
    model_config_id: newId,
  })
  return json({ id: newId })
}

async function handleUpdate(userId: string, p: UpdatePayload): Promise<Response> {
  if (!p.id) return json({ error: 'id is required' }, 400)
  const svc = serviceClient()
  let newSecretId: string | null = null

  // 输入新 API Key 时：先创建新 secret，再更新引用，成功后删除旧 secret。
  if (p.api_key && p.api_key.trim() !== '') {
    let apiKey: string | null = p.api_key
    try {
      newSecretId = await createVaultSecret(svc, apiKey, `ai_model_${crypto.randomUUID()}`)
    } finally {
      apiKey = null
    }
  }

  const { data: oldSecretId, error } = await svc.rpc('admin_update_model_config', {
    p_actor_id: userId,
    p_id: p.id,
    p_display_name: p.display_name ?? null,
    p_base_url: p.base_url ?? null,
    p_model_name: p.model_name ?? null,
    p_new_api_key_secret_id: newSecretId,
    p_max_parallel_tasks: p.max_parallel_tasks ?? null,
    p_request_timeout_ms: p.request_timeout_ms ?? null,
    p_context_window: p.context_window ?? null,
    p_max_output_tokens: p.max_output_tokens ?? null,
    // agent_max_*_requests 不传：RPC 里这些参数默认 null，coalesce 会保留现值，
    // 不会把「默认能力策略」页刚保存的预算冲掉。
  })

  if (error) {
    // 更新失败：回收本次新建的 secret
    if (newSecretId) await deleteVaultSecret(svc, newSecretId)
    logEvent('update_failed', { userId, model_config_id: p.id, reason: reason(error) })
    return json({ error: failure('failed to update model config', error) }, 400)
  }

  // 轮换成功后清理旧 secret（admin_update_model_config 返回旧 secret id）
  if (newSecretId && oldSecretId) {
    await deleteVaultSecret(svc, oldSecretId as string)
    logEvent('rotated_key', { userId, model_config_id: p.id })
  }

  logEvent('updated', {
    userId,
    model_config_id: p.id,
  })
  return json({ id: p.id })
}

async function handleDelete(userId: string, p: DeletePayload): Promise<Response> {
  if (!p.id) return json({ error: 'id is required' }, 400)

  const svc = serviceClient()
  const { data: deletedId, error } = await svc.rpc('admin_delete_model_config', {
    p_actor_id: userId,
    p_id: p.id,
  })

  if (error) {
    const why = reason(error) ?? ''
    if (why.includes('MODEL_CONFIG_REFERENCED')) {
      return json({ error: '请先删除已经选择了该模型的代码评审批次' }, 409)
    }
    if (why.includes('MODEL_CONFIG_NOT_FOUND')) {
      return json({ error: '模型配置不存在或已被删除' }, 404)
    }
    logEvent('delete_failed', { userId, model_config_id: p.id, reason: why })
    return json({ error: failure('failed to delete model config', error) }, 400)
  }

  if (deletedId !== p.id) {
    logEvent('delete_result_mismatch', { userId, model_config_id: p.id })
    return json({ error: '模型配置删除结果校验失败' }, 500)
  }

  // 0023 起数据库会在同一事务中删除模型配置与 Vault secret。
  logEvent('deleted', { userId, model_config_id: p.id })
  return json({ id: deletedId })
}

// 最小连通性测试：不发送任何代码或需求，只发送一个极短探测消息。
async function handleTest(userId: string, p: TestPayload): Promise<Response> {
  const svc = serviceClient()
  let baseUrl = p.base_url
  let modelName = p.model_name
  let apiKey: string | null = p.api_key ?? null
  let timeoutMs = 30000

  // 使用已存在配置测试：从库读取元数据 + 通过 public RPC 从 Vault 读取密钥（仅服务端内存）。
  if (p.id) {
    const { data: cfg, error: cfgErr } = await svc
      .from('ai_model_config')
      .select('base_url, model_name, request_timeout_ms')
      .eq('id', p.id)
      .maybeSingle()
    if (cfgErr || !cfg) return json({ error: 'model config not found' }, 404)

    baseUrl = cfg.base_url as string
    modelName = cfg.model_name as string
    timeoutMs = Math.min((cfg.request_timeout_ms as number) ?? 30000, 30000)

    const { data: secret, error: secErr } = await svc.rpc('admin_get_model_secret_by_config', {
      p_id: p.id,
    })
    if (secErr || !secret) return json({ error: 'model secret missing' }, 400)
    apiKey = secret as string
  }

  if (!baseUrl || !modelName || !apiKey) {
    return json({ error: 'base_url, model_name, api_key are required for test' }, 400)
  }

  // 所有模型端点统一使用 OpenAI-compatible chat/completions。

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  let ok = false
  let statusCode = 0
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions'
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    })
    statusCode = resp.status
    ok = resp.ok
    // 读取并丢弃响应体，避免任何内容进入日志。
    await resp.text().catch(() => '')
  } catch {
    ok = false
  } finally {
    clearTimeout(timer)
    apiKey = null // 清空密钥
  }

  const latencyMs = Date.now() - startedAt
  logEvent('tested', { userId, ok, statusCode, latency_ms: latencyMs })
  // 前端展示 latency_ms 与 message，缺失时它只能显示兜底文案。
  return json({
    ok,
    statusCode,
    latency_ms: latencyMs,
    message: ok
      ? undefined
      : statusCode > 0
        ? `模型返回 HTTP ${statusCode}`
        : '请求未能到达模型端点（超时或网络不可达）',
  })
}

Deno.serve(async (req: Request): Promise<Response> => {
  CURRENT_CORS = corsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CURRENT_CORS })
  }
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405)
  }

  const admin = await requireAdmin(req)
  if (admin instanceof Response) return admin

  let raw: Record<string, unknown>
  try {
    raw = (await req.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  // 兼容两种发送体：扁平（{action, ...fields}）或嵌套（{action, id?, input:{...}}）。
  const nested =
    raw && typeof raw === 'object' && raw.input && typeof raw.input === 'object'
      ? (raw.input as Record<string, unknown>)
      : {}
  const merged: Record<string, unknown> = { ...nested, ...raw }
  // 删除已并入的 input，避免污染
  delete merged.input
  const payload = merged as unknown as Payload

  // 绝不打印请求体。
  switch (payload.action) {
    case 'create':
      return await handleCreate(admin.userId, payload as CreatePayload)
    case 'update':
      return await handleUpdate(admin.userId, payload as UpdatePayload)
    case 'delete':
      return await handleDelete(admin.userId, payload as DeletePayload)
    case 'test':
      return await handleTest(admin.userId, payload as TestPayload)
    default:
      return json({ error: 'unknown action' }, 400)
  }
})
