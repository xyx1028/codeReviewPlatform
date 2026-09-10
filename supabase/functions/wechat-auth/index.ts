// 微信开放平台“网站应用”扫码登录及已有 Supabase 用户绑定。
// 微信密钥、access token、openid/unionid 始终只在服务端处理。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const WECHAT_APP_ID = Deno.env.get('WECHAT_APP_ID') ?? ''
const WECHAT_APP_SECRET = Deno.env.get('WECHAT_APP_SECRET') ?? ''
const WECHAT_CALLBACK_URL = Deno.env.get('WECHAT_CALLBACK_URL') ?? ''
const ALLOW_LOCAL_ORIGINS = Deno.env.get('ALLOW_LOCAL_ORIGINS') === 'true'
const OAUTH_COOKIE = 'wechat_oauth_nonce'
const OAUTH_TTL_SECONDS = 10 * 60
const SYNTHETIC_EMAIL_SUFFIX = '@wechat.invalid'
const LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]

type OAuthMode = 'LOGIN' | 'BIND'

interface OAuthAttempt {
  mode: OAuthMode
  user_id: string | null
  redirect_to: string
  browser_nonce_hash: string | null
  client_nonce_hash: string | null
}

interface WechatTokenResponse {
  access_token?: string
  openid?: string
  unionid?: string
  errcode?: number
}

interface WechatUserResponse {
  nickname?: string
  headimgurl?: string
  unionid?: string
  errcode?: number
}

interface WechatIdentity {
  user_id: string
  nickname: string | null
  avatar_url: string | null
}

function serviceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function allowedOrigins(): Set<string> {
  const configured = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean)
  return new Set([...configured, ...(ALLOW_LOCAL_ORIGINS ? LOCAL_ORIGINS : [])])
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = (req.headers.get('Origin') ?? '').replace(/\/+$/, '')
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
  if (allowedOrigins().has(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

function baseHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  }
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...baseHeaders(), ...corsHeaders(req), 'Content-Type': 'application/json' },
  })
}

function text(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { ...baseHeaders(), 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ ...baseHeaders(), Location: location })
  if (cookie) headers.set('Set-Cookie', cookie)
  return new Response(null, { status: 302, headers })
}

function redirectResult(target: URL, key: string, value: string, cookie?: string): Response {
  target.hash = new URLSearchParams({ [key]: value }).toString()
  return redirect(target.toString(), cookie)
}

function logEvent(event: string, details: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(details)) {
    if (/code|email|key|openid|secret|state|token|unionid/i.test(key)) continue
    safe[key] = value
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), fn: 'wechat-auth', event, ...safe }))
}

function validateRedirect(raw: unknown): URL | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const target = new URL(raw)
    if (!['http:', 'https:'].includes(target.protocol)) return null
    if (!allowedOrigins().has(target.origin.replace(/\/+$/, ''))) return null
    target.hash = ''
    return target
  } catch {
    return null
  }
}

function callbackUrl(req: Request): URL | null {
  try {
    const callback = new URL(WECHAT_CALLBACK_URL)
    if (callback.origin !== new URL(req.url).origin) return null
    callback.hash = ''
    return callback
  } catch {
    return null
  }
}

function configurationError(): string | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) return 'Supabase 服务端配置不完整'
  if (!WECHAT_APP_ID || !WECHAT_APP_SECRET || !WECHAT_CALLBACK_URL) return '微信登录服务尚未配置'
  return null
}

function oauthCookie(req: Request, value: string, maxAge: number): string {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : ''
  return `${OAUTH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const [cookieName, ...value] = part.trim().split('=')
    if (cookieName === name) return value.join('=')
  }
  return null
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function requireUser(req: Request): Promise<string | Response> {
  const authorization = req.headers.get('Authorization') ?? ''
  if (!authorization.startsWith('Bearer ')) return json(req, { error: '未登录' }, 401)

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) return json(req, { error: '登录已失效' }, 401)
  return data.user.id
}

async function createAttempt(
  mode: OAuthMode,
  target: URL,
  userId: string | null,
  browserNonce: string | null,
  clientNonceHash: string | null,
): Promise<string> {
  const state = crypto.randomUUID().replace(/-/g, '')
  const svc = serviceClient()
  await svc.from('wechat_oauth_attempt').delete().lt('expires_at', new Date().toISOString())
  const { error } = await svc.from('wechat_oauth_attempt').insert({
    state_hash: await sha256Hex(state),
    mode,
    user_id: userId,
    redirect_to: target.toString(),
    browser_nonce_hash: browserNonce ? await sha256Hex(browserNonce) : null,
    client_nonce_hash: clientNonceHash,
    expires_at: new Date(Date.now() + OAUTH_TTL_SECONDS * 1000).toISOString(),
  })
  if (error) throw new Error('failed to create OAuth attempt')
  return state
}

function buildWechatAuthorizationUrl(state: string, callback: URL): string {
  const url = new URL('https://open.weixin.qq.com/connect/qrconnect')
  url.searchParams.set('appid', WECHAT_APP_ID)
  url.searchParams.set('redirect_uri', callback.toString())
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'snsapi_login')
  url.searchParams.set('state', state)
  url.hash = 'wechat_redirect'
  return url.toString()
}

async function consumeAttempt(state: string): Promise<OAuthAttempt | null> {
  const { data, error } = await serviceClient()
    .from('wechat_oauth_attempt')
    .delete()
    .eq('state_hash', await sha256Hex(state))
    .gt('expires_at', new Date().toISOString())
    .select('mode, user_id, redirect_to, browser_nonce_hash, client_nonce_hash')
    .maybeSingle()
  if (error) throw new Error('failed to consume OAuth attempt')
  return data as OAuthAttempt | null
}

async function fetchWechatJson<T>(url: URL): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`wechat upstream HTTP ${response.status}`)
  return (await response.json()) as T
}

async function exchangeWechatCode(code: string): Promise<{
  openid: string
  unionid: string | null
  nickname: string
  avatarUrl: string | null
}> {
  const tokenUrl = new URL('https://api.weixin.qq.com/sns/oauth2/access_token')
  tokenUrl.searchParams.set('appid', WECHAT_APP_ID)
  tokenUrl.searchParams.set('secret', WECHAT_APP_SECRET)
  tokenUrl.searchParams.set('code', code)
  tokenUrl.searchParams.set('grant_type', 'authorization_code')
  const token = await fetchWechatJson<WechatTokenResponse>(tokenUrl)
  if (token.errcode || !token.access_token || !token.openid) throw new Error('WeChat code exchange failed')

  let profile: WechatUserResponse = {}
  try {
    const userUrl = new URL('https://api.weixin.qq.com/sns/userinfo')
    userUrl.searchParams.set('access_token', token.access_token)
    userUrl.searchParams.set('openid', token.openid)
    userUrl.searchParams.set('lang', 'zh_CN')
    const response = await fetchWechatJson<WechatUserResponse>(userUrl)
    if (!response.errcode) profile = response
  } catch {
    logEvent('profile_unavailable')
  }

  const nickname = profile.nickname?.trim().slice(0, 80)
    || `微信用户${(await sha256Hex(token.openid)).slice(0, 6)}`
  return {
    openid: token.openid,
    unionid: token.unionid ?? profile.unionid ?? null,
    nickname,
    avatarUrl: profile.headimgurl ?? null,
  }
}

async function findIdentity(openid: string, unionid: string | null): Promise<WechatIdentity | null> {
  const svc = serviceClient()
  const byOpenid = await svc
    .from('wechat_identity')
    .select('user_id, nickname, avatar_url')
    .eq('app_id', WECHAT_APP_ID)
    .eq('openid', openid)
    .maybeSingle()
  if (byOpenid.error) throw new Error('failed to query WeChat identity')
  if (byOpenid.data) return byOpenid.data as WechatIdentity
  if (!unionid) return null

  const byUnionid = await svc
    .from('wechat_identity')
    .select('user_id, nickname, avatar_url')
    .eq('app_id', WECHAT_APP_ID)
    .eq('unionid', unionid)
    .maybeSingle()
  if (byUnionid.error) throw new Error('failed to query WeChat union identity')
  return byUnionid.data as WechatIdentity | null
}

async function bindIdentity(
  userId: string,
  identity: { openid: string; unionid: string | null; nickname: string; avatarUrl: string | null },
): Promise<void> {
  const svc = serviceClient()
  const existingWechat = await findIdentity(identity.openid, identity.unionid)
  if (existingWechat && existingWechat.user_id !== userId) throw new Error('WECHAT_ALREADY_BOUND')

  const currentBinding = await svc
    .from('wechat_identity')
    .select('user_id, openid')
    .eq('user_id', userId)
    .maybeSingle()
  if (currentBinding.error) throw new Error('failed to query current binding')
  if (currentBinding.data && currentBinding.data.openid !== identity.openid) throw new Error('USER_ALREADY_BOUND')

  if (currentBinding.data) {
    const { error } = await svc.from('wechat_identity').update({
      unionid: identity.unionid,
      nickname: identity.nickname,
      avatar_url: identity.avatarUrl,
      last_login_at: new Date().toISOString(),
    }).eq('user_id', userId)
    if (error) throw new Error('failed to update WeChat binding')
    return
  }

  const { error } = await svc.from('wechat_identity').insert({
    app_id: WECHAT_APP_ID,
    openid: identity.openid,
    unionid: identity.unionid,
    user_id: userId,
    nickname: identity.nickname,
    avatar_url: identity.avatarUrl,
  })
  if (error?.code === '23505') throw new Error('WECHAT_ALREADY_BOUND')
  if (error) throw new Error('failed to bind WeChat identity')
}

async function resolveLoginUser(
  identity: { openid: string; unionid: string | null; nickname: string; avatarUrl: string | null },
): Promise<string> {
  const existing = await findIdentity(identity.openid, identity.unionid)
  if (existing) {
    await bindIdentity(existing.user_id, identity)
    return existing.user_id
  }

  const subjectHash = await sha256Hex(`${WECHAT_APP_ID}:${identity.openid}`)
  const email = `wx_${subjectHash.slice(0, 48)}${SYNTHETIC_EMAIL_SUFFIX}`
  let password: string | null = `${crypto.randomUUID()}${crypto.randomUUID()}Aa1!`
  const svc = serviceClient()
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      auth_provider: 'wechat',
      name: identity.nickname,
      avatar_url: identity.avatarUrl,
    },
  })
  password = null
  if (error || !data.user) {
    // 并发首次登录可能已由另一请求创建同一 deterministic email；等待其身份映射落库。
    if (error && /already|registered|exists/i.test(`${(error as { code?: string }).code ?? ''} ${error.message}`)) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
        const winner = await findIdentity(identity.openid, identity.unionid)
        if (winner) return winner.user_id
      }
    }
    throw new Error('failed to create Supabase user')
  }

  try {
    await bindIdentity(data.user.id, identity)
    return data.user.id
  } catch (bindError) {
    await svc.auth.admin.deleteUser(data.user.id)
    if (bindError instanceof Error && bindError.message === 'WECHAT_ALREADY_BOUND') {
      const winner = await findIdentity(identity.openid, identity.unionid)
      if (winner) return winner.user_id
    }
    throw bindError
  }
}

async function issueLoginToken(userId: string): Promise<string> {
  const svc = serviceClient()
  const { data: userData, error: userError } = await svc.auth.admin.getUserById(userId)
  const email = userData.user?.email
  if (userError || !email) throw new Error('Supabase user has no login email')

  const { data, error } = await svc.auth.admin.generateLink({ type: 'magiclink', email })
  const tokenHash = data?.properties?.hashed_token
  if (error || !tokenHash) throw new Error('failed to issue Supabase login token')
  return tokenHash
}

async function handleLoginStart(req: Request, url: URL): Promise<Response> {
  const target = validateRedirect(url.searchParams.get('redirect_to'))
  const clientNonceHash = url.searchParams.get('client_nonce_hash')
  if (!target) return text('invalid redirect_to', 400)
  if (!clientNonceHash || !/^[a-f0-9]{64}$/.test(clientNonceHash)) return text('invalid client nonce', 400)
  const configError = configurationError()
  if (configError) return redirectResult(target, 'wechat_error', configError)
  const callback = callbackUrl(req)
  if (!callback) return redirectResult(target, 'wechat_error', '微信回调地址必须与登录入口同源')

  const browserNonce = crypto.randomUUID().replace(/-/g, '')
  const state = await createAttempt('LOGIN', target, null, browserNonce, clientNonceHash)
  logEvent('login_started')
  return redirect(
    buildWechatAuthorizationUrl(state, callback),
    oauthCookie(req, browserNonce, OAUTH_TTL_SECONDS),
  )
}

async function handleCallback(req: Request, url: URL): Promise<Response> {
  const state = url.searchParams.get('state')
  if (!state) return text('invalid OAuth state', 400)
  const attempt = await consumeAttempt(state)
  if (!attempt) return text('微信登录状态无效或已过期，请返回应用重试', 400)

  const target = validateRedirect(attempt.redirect_to)
  if (!target) return text('invalid OAuth redirect', 400)
  const clearCookie = oauthCookie(req, '', 0)
  const errorKey = attempt.mode === 'BIND' ? 'wechat_binding_error' : 'wechat_error'

  if (attempt.mode === 'LOGIN') {
    const browserNonce = readCookie(req, OAUTH_COOKIE)
    if (!browserNonce || await sha256Hex(browserNonce) !== attempt.browser_nonce_hash) {
      logEvent('login_state_rejected')
      return redirectResult(target, errorKey, '微信登录状态无效或已过期', clearCookie)
    }
  }

  const configError = configurationError()
  if (configError) return redirectResult(target, errorKey, configError, clearCookie)
  const code = url.searchParams.get('code')
  if (!code) return redirectResult(target, errorKey, '微信授权未完成，请重试', clearCookie)

  try {
    const identity = await exchangeWechatCode(code)
    const svc = serviceClient()
    const ticket = crypto.randomUUID().replace(/-/g, '')
    const ticketHash = await sha256Hex(ticket)
    const expiresAt = new Date(Date.now() + OAUTH_TTL_SECONDS * 1000).toISOString()

    if (attempt.mode === 'BIND') {
      if (!attempt.user_id) throw new Error('binding user is missing')
      const { error } = await svc.from('wechat_binding_handoff').insert({
        ticket_hash: ticketHash,
        user_id: attempt.user_id,
        openid: identity.openid,
        unionid: identity.unionid,
        nickname: identity.nickname,
        avatar_url: identity.avatarUrl,
        expires_at: expiresAt,
      })
      if (error) throw new Error('failed to create binding handoff')
      logEvent('binding_scanned', { userId: attempt.user_id })
      return redirectResult(target, 'wechat_binding_ticket', ticket, clearCookie)
    }

    if (!attempt.client_nonce_hash) throw new Error('login client nonce is missing')
    const userId = await resolveLoginUser(identity)
    const { error } = await svc.from('wechat_login_handoff').insert({
      ticket_hash: ticketHash,
      user_id: userId,
      client_nonce_hash: attempt.client_nonce_hash,
      expires_at: expiresAt,
    })
    if (error) throw new Error('failed to create login handoff')
    logEvent('login_scanned', { userId })
    return redirectResult(target, 'wechat_handoff', ticket, clearCookie)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown'
    logEvent('oauth_failed', { reason })
    const message = reason === 'WECHAT_ALREADY_BOUND'
      ? '该微信已绑定其他账号'
      : reason === 'USER_ALREADY_BOUND'
        ? '当前账号已绑定其他微信'
        : attempt.mode === 'BIND' ? '微信绑定失败，请重试' : '微信登录失败，请重试'
    return redirectResult(target, errorKey, message, clearCookie)
  }
}

async function bindingStatus(req: Request, userId: string): Promise<Response> {
  const { data, error } = await serviceClient()
    .from('wechat_identity')
    .select('nickname, avatar_url')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return json(req, { error: '读取微信绑定状态失败' }, 500)

  const { data: userData } = await serviceClient().auth.admin.getUserById(userId)
  const email = userData.user?.email ?? ''
  return json(req, {
    configured: configurationError() === null,
    bound: Boolean(data),
    nickname: data?.nickname ?? null,
    avatar_url: data?.avatar_url ?? null,
    can_unbind: Boolean(data) && !email.endsWith(SYNTHETIC_EMAIL_SUFFIX),
  })
}

async function handlePost(req: Request): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return json(req, { error: '请求格式错误' }, 400)
  }

  const action = body.action
  if (action === 'exchange_login') {
    const ticket = typeof body.ticket === 'string' ? body.ticket : ''
    const clientNonce = typeof body.client_nonce === 'string' ? body.client_nonce : ''
    if (!ticket || !clientNonce) return json(req, { error: '微信登录交接凭据无效' }, 400)

    const { data, error } = await serviceClient()
      .from('wechat_login_handoff')
      .delete()
      .eq('ticket_hash', await sha256Hex(ticket))
      .gt('expires_at', new Date().toISOString())
      .select('user_id, client_nonce_hash')
      .maybeSingle()
    if (error || !data || await sha256Hex(clientNonce) !== data.client_nonce_hash) {
      return json(req, { error: '微信登录交接凭据无效或已过期' }, 400)
    }

    try {
      return json(req, { token_hash: await issueLoginToken(data.user_id) })
    } catch {
      return json(req, { error: '签发登录会话失败' }, 500)
    }
  }

  const user = await requireUser(req)
  if (user instanceof Response) return user
  if (action === 'status') return bindingStatus(req, user)

  if (action === 'begin_binding') {
    const target = validateRedirect(body.redirect_to)
    if (!target) return json(req, { error: '回调地址无效' }, 400)
    const configError = configurationError()
    if (configError) return json(req, { error: configError }, 503)
    const callback = callbackUrl(req)
    if (!callback) return json(req, { error: '微信回调地址必须与函数入口同源' }, 500)
    try {
      const state = await createAttempt('BIND', target, user, null, null)
      return json(req, { authorization_url: buildWechatAuthorizationUrl(state, callback) })
    } catch {
      return json(req, { error: '创建微信绑定请求失败' }, 500)
    }
  }

  if (action === 'confirm_binding') {
    const ticket = typeof body.ticket === 'string' ? body.ticket : ''
    if (!ticket) return json(req, { error: '微信绑定凭据无效' }, 400)
    const { data, error } = await serviceClient()
      .from('wechat_binding_handoff')
      .delete()
      .eq('ticket_hash', await sha256Hex(ticket))
      .eq('user_id', user)
      .gt('expires_at', new Date().toISOString())
      .select('openid, unionid, nickname, avatar_url')
      .maybeSingle()
    if (error || !data) return json(req, { error: '微信绑定凭据无效、已过期或不属于当前账号' }, 400)

    try {
      await bindIdentity(user, {
        openid: data.openid,
        unionid: data.unionid,
        nickname: data.nickname,
        avatarUrl: data.avatar_url,
      })
      logEvent('binding_completed', { userId: user })
      return json(req, { ok: true })
    } catch (bindError) {
      const reason = bindError instanceof Error ? bindError.message : ''
      const message = reason === 'WECHAT_ALREADY_BOUND'
        ? '该微信已绑定其他账号'
        : reason === 'USER_ALREADY_BOUND' ? '当前账号已绑定其他微信' : '微信绑定失败'
      return json(req, { error: message }, 400)
    }
  }

  if (action === 'unbind') {
    const password = typeof body.password === 'string' ? body.password : ''
    if (!password) return json(req, { error: '请输入当前邮箱密码确认解绑' }, 400)

    const svc = serviceClient()
    const { data: userData } = await svc.auth.admin.getUserById(user)
    const email = userData.user?.email
    if (!email || email.endsWith(SYNTHETIC_EMAIL_SUFFIX)) {
      return json(req, { error: '微信是当前账号唯一登录方式，不能解绑' }, 400)
    }

    const passwordClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: verified, error: verifyError } = await passwordClient.auth.signInWithPassword({ email, password })
    if (verifyError || verified.user?.id !== user) {
      return json(req, { error: '邮箱密码验证失败，未解绑微信' }, 403)
    }
    // 仅撤销本次服务端密码校验产生的临时 session，不影响浏览器现有 session。
    await passwordClient.auth.signOut({ scope: 'local' })

    const { error } = await svc.from('wechat_identity').delete().eq('user_id', user)
    if (error) return json(req, { error: '解绑微信失败' }, 500)
    logEvent('binding_removed', { userId: user })
    return json(req, { ok: true })
  }

  return json(req, { error: '未知操作' }, 400)
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })
  const url = new URL(req.url)

  try {
    if (req.method === 'GET' && url.pathname.endsWith('/start')) return await handleLoginStart(req, url)
    if (req.method === 'GET' && url.pathname.endsWith('/callback')) return await handleCallback(req, url)
    if (req.method === 'POST') return await handlePost(req)
    return text('method not allowed', 405)
  } catch (error) {
    logEvent('unhandled_error', { reason: error instanceof Error ? error.message : 'unknown' })
    return req.method === 'POST'
      ? json(req, { error: '微信认证服务异常' }, 500)
      : text('微信认证服务异常，请返回应用重试', 500)
  }
})
