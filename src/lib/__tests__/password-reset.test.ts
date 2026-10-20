import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resetPasswordForEmailMock = vi.hoisted(() => vi.fn())
const updateUserMock = vi.hoisted(() => vi.fn())
const signOutMock = vi.hoisted(() => vi.fn())
const onAuthStateChangeMock = vi.hoisted(() => vi.fn())

vi.mock('../supabase', () => ({
  requireSupabase: () => ({
    auth: {
      resetPasswordForEmail: resetPasswordForEmailMock,
      updateUser: updateUserMock,
      signOut: signOutMock,
      onAuthStateChange: onAuthStateChangeMock,
    },
  }),
}))

import {
  PasswordResetSignOutError,
  completePasswordReset,
  onAuthChange,
  requestPasswordReset,
} from '../api'
import {
  clearRecoveryFlow,
  isRecoveryFlow,
  parseRecoveryLanding,
} from '../password-recovery'

describe('V1.64 忘记密码自助重置', () => {
  beforeEach(() => {
    resetPasswordForEmailMock.mockReset()
    updateUserMock.mockReset()
    signOutMock.mockReset()
    onAuthStateChangeMock.mockReset()
    clearRecoveryFlow()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearRecoveryFlow()
  })

  describe('发起重置', () => {
    it('把回调地址固定到本站的 /reset-password', async () => {
      vi.stubGlobal('window', { location: { origin: 'http://crp-review.kingdee.com' } })
      resetPasswordForEmailMock.mockResolvedValue({ data: {}, error: null })

      await expect(requestPasswordReset('dev@example.com')).resolves.toBeUndefined()
      expect(resetPasswordForEmailMock).toHaveBeenCalledWith('dev@example.com', {
        redirectTo: 'http://crp-review.kingdee.com/reset-password',
      })
    })

    it('没配 SMTP 时把真实原因翻译出来，而不是停在假的成功页', async () => {
      vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } })
      resetPasswordForEmailMock.mockResolvedValue({
        data: null,
        // GoTrue 的 AuthError 是 Error 子类；这里保持同样的形状，否则测不到文案翻译。
        error: Object.assign(new Error('Error sending recovery email'), { code: 'unexpected_failure' }),
      })

      await expect(requestPasswordReset('dev@example.com')).rejects.toMatchObject({
        code: 'mail_send_failed',
        message: expect.stringContaining('SMTP'),
      })
    })

    it('发信频率限制保留 GoTrue 给出的剩余秒数', async () => {
      vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } })
      resetPasswordForEmailMock.mockResolvedValue({
        data: null,
        error: Object.assign(
          new Error('For security purposes, you can only request this after 47 seconds.'),
          { code: 'over_request_rate_limit' },
        ),
      })

      await expect(requestPasswordReset('dev@example.com')).rejects.toThrow('操作过于频繁，请 47 秒后再试。')
    })
  })

  describe('设置新密码', () => {
    it('改完密码吊销全部会话（含当前设备）', async () => {
      updateUserMock.mockResolvedValue({ data: {}, error: null })
      signOutMock.mockResolvedValue({ error: null })

      await expect(completePasswordReset('new-password-1')).resolves.toBeUndefined()
      expect(updateUserMock).toHaveBeenCalledWith({ password: 'new-password-1' })
      expect(signOutMock).toHaveBeenCalledWith({ scope: 'global' })
    })

    it('新密码与原密码相同时给中文提示，且不吊销会话', async () => {
      updateUserMock.mockResolvedValue({
        data: null,
        error: Object.assign(
          new Error('New password should be different from the old password.'),
          { code: 'same_password' },
        ),
      })

      await expect(completePasswordReset('old-password')).rejects.toThrow('新密码不能与原密码相同，请换一个。')
      expect(signOutMock).not.toHaveBeenCalled()
    })

    it('密码已改成功但全局登出失败时，用独立错误类型区分处置', async () => {
      updateUserMock.mockResolvedValue({ data: {}, error: null })
      signOutMock.mockResolvedValue({ error: new Error('network error') })

      await expect(completePasswordReset('new-password-1')).rejects.toBeInstanceOf(PasswordResetSignOutError)
    })
  })

  describe('恢复落地识别', () => {
    it('识别 implicit 流程的恢复片段', () => {
      expect(parseRecoveryLanding('#access_token=abc&refresh_token=def&type=recovery', '')).toEqual({
        credential: true,
        error: null,
      })
    })

    // 下面两个片段是本地 GoTrue（supabase_auth，2026-10-20 实测）verify 接口 303 回来的原文，
    // 只替换了令牌值。参数顺序和多出来的 `sb=` 都照抄，避免解析逻辑只对"想象中的格式"成立。
    it('识别 GoTrue 实际回传的恢复片段', () => {
      const landing = parseRecoveryLanding(
        '#access_token=<token>&expires_at=1792483579&expires_in=3600&refresh_token=<refresh>&sb=&token_type=bearer&type=recovery',
        '',
      )
      expect(landing).toEqual({ credential: true, error: null })
    })

    it('识别 GoTrue 实际回传的链接失效片段', () => {
      const landing = parseRecoveryLanding(
        '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=',
        '',
      )
      expect(landing).toEqual({
        credential: false,
        error: '重置链接已过期或已被使用过，请重新发起找回密码。',
      })
    })

    it('识别 PKCE 流程的 code 参数', () => {
      expect(parseRecoveryLanding('', '?code=auth-code')).toEqual({ credential: true, error: null })
    })

    it('链接过期时给出可行动的中文原因，并且不认为有凭据', () => {
      const landing = parseRecoveryLanding(
        '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
        '',
      )
      expect(landing.credential).toBe(false)
      expect(landing.error).toBe('重置链接已过期或已被使用过，请重新发起找回密码。')
    })

    it('未收录的错误码退回 GoTrue 的原始描述', () => {
      expect(parseRecoveryLanding('#error_code=weird_failure&error_description=Something+odd', '').error)
        .toBe('Something odd')
    })

    it('普通访问不算恢复落地', () => {
      expect(parseRecoveryLanding('', '')).toEqual({ credential: false, error: null })
    })

    it('PASSWORD_RECOVERY 事件是落地识别的第二来源，hash 被清掉也认得出来', () => {
      const listeners: ((event: string, session: unknown) => void)[] = []
      onAuthStateChangeMock.mockImplementation((listener: (event: string, session: unknown) => void) => {
        listeners.push(listener)
        return { data: { subscription: { unsubscribe: () => undefined } } }
      })
      const observed: unknown[] = []

      onAuthChange((session) => observed.push(session))
      expect(isRecoveryFlow()).toBe(false)

      listeners[0]('PASSWORD_RECOVERY', { access_token: 'token' })
      expect(isRecoveryFlow()).toBe(true)
      expect(observed).toEqual([{ access_token: 'token' }])

      clearRecoveryFlow()
      expect(isRecoveryFlow()).toBe(false)
    })
  })
})
