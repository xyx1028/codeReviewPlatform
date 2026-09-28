import { beforeEach, describe, expect, it, vi } from 'vitest'

const signUpMock = vi.hoisted(() => vi.fn())
const signOutMock = vi.hoisted(() => vi.fn())

vi.mock('../supabase', () => ({
  requireSupabase: () => ({ auth: { signUp: signUpMock, signOut: signOutMock } }),
}))

import { clearLocalAuthSession, signUp } from '../api'

describe('V1.39 注册邮箱确认适配', () => {
  beforeEach(() => {
    signUpMock.mockReset()
    signOutMock.mockReset()
  })

  it('GoTrue 返回会话时不要求邮箱确认，并转交原始注册参数', async () => {
    signUpMock.mockResolvedValue({
      data: {
        user: { identities: [{ id: 'identity-1' }] },
        session: { access_token: 'access-token' },
      },
      error: null,
    })

    await expect(signUp('experience@example.com', 'password-123')).resolves.toEqual({
      alreadyRegistered: false,
      needsEmailConfirmation: false,
    })
    expect(signUpMock).toHaveBeenCalledWith({
      email: 'experience@example.com',
      password: 'password-123',
    })
  })

  it('未返回会话时保留邮箱确认兼容分支', async () => {
    signUpMock.mockResolvedValue({
      data: {
        user: { identities: [] },
        session: null,
      },
      error: null,
    })

    await expect(signUp('existing@example.com', 'password-123')).resolves.toEqual({
      alreadyRegistered: true,
      needsEmailConfirmation: true,
    })
  })

  it('清除自动建立的浏览器会话，不影响服务器侧账号', async () => {
    signOutMock.mockResolvedValue({ error: null })

    await expect(clearLocalAuthSession()).resolves.toBeUndefined()
    expect(signOutMock).toHaveBeenCalledWith({ scope: 'local' })
  })
})
