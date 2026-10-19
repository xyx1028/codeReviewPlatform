/**
 * V1.56：Linky 上游错误响应的解析。
 *
 * 全部对着 2026-10-19 对 `feature.kingdee.com:2055` 的实测响应写：
 *
 *   · `/stories?workspace_name=工具组`        → 200 {"items":[],"total":0}
 *   · `/stories?workspace_name=工具开发组`    → 400 {"detail":"Linky 返回错误（401）：invalid token"}
 *   · `/stories/US-2026-017341`               → 404 {"detail":"未找到用户故事: US-2026-017341"}
 *
 * 这三种响应此前在平台上长得一模一样（「LINKY_NETWORK_ERROR」或「Linky 返回 HTTP 400」），
 * 而它们的处置完全不同：改项目组名 / 找质量执行平台换 token / 改需求编号。
 */
import { describe, expect, it } from 'vitest'
import { extractUpstreamDetail, isUpstreamAuthFailure } from '../linky/client.js'

describe('extractUpstreamDetail', () => {
  it('取出 detail —— 那才是可操作的那句话，"HTTP 400"不是', () => {
    expect(
      extractUpstreamDetail(Buffer.from('{"detail":"Linky 返回错误（401）：invalid token"}')),
    ).toBe('Linky 返回错误（401）：invalid token')
    expect(
      extractUpstreamDetail(Buffer.from('{"detail":"未找到用户故事: US-2026-017341"}')),
    ).toBe('未找到用户故事: US-2026-017341')
  })

  it('响应体不是 JSON 时截一段原文，而不是丢掉', () => {
    expect(
      extractUpstreamDetail(Buffer.from('<html>\n  <body>502 Bad Gateway</body>\n</html>')),
    ).toContain('502 Bad Gateway')
  })

  it('空体返回 null，不编一句话出来', () => {
    expect(extractUpstreamDetail(Buffer.from(''))).toBeNull()
    expect(extractUpstreamDetail(Buffer.from('   '))).toBeNull()
  })

  it('JSON 里没有可用字段时返回 null', () => {
    expect(extractUpstreamDetail(Buffer.from('{"items":[],"total":0}'))).toBeNull()
  })
})

describe('isUpstreamAuthFailure', () => {
  it('实测形态：外层 400、内层 401 invalid token —— 属于平台侧凭据失效', () => {
    expect(isUpstreamAuthFailure(400, 'Linky 返回错误（401）：invalid token')).toBe(true)
  })

  it('401 / 403 即便没有 detail 也算凭据问题', () => {
    expect(isUpstreamAuthFailure(401, null)).toBe(true)
    expect(isUpstreamAuthFailure(403, null)).toBe(true)
  })

  it('普通参数类 400 不算：它的处置是改参数，不是换 token', () => {
    expect(isUpstreamAuthFailure(400, '编号为空')).toBe(false)
    expect(isUpstreamAuthFailure(400, null)).toBe(false)
  })

  it('404 与 5xx 都不算凭据问题', () => {
    expect(isUpstreamAuthFailure(404, '未找到用户故事: US-2026-017341')).toBe(false)
    expect(isUpstreamAuthFailure(500, 'boom')).toBe(false)
    expect(isUpstreamAuthFailure(502, null)).toBe(false)
  })

  it('中文「token 失效/过期」也要认出来', () => {
    expect(isUpstreamAuthFailure(400, 'Linky 连接 token 已失效')).toBe(true)
    expect(isUpstreamAuthFailure(400, 'token 过期')).toBe(true)
  })
})
