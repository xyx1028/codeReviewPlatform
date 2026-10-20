import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpcMock = vi.hoisted(() => vi.fn())

vi.mock('../supabase', () => ({
  requireSupabase: () => ({ rpc: rpcMock }),
}))

import { adminResetUserPassword } from '../api'
import {
  TEMP_PASSWORD_MAX_BYTES,
  TEMP_PASSWORD_MIN_LENGTH,
  describeAdminPasswordResetError,
  generateTemporaryPassword,
  validateTemporaryPassword,
} from '../admin-password-reset'

describe('V1.65 管理员代重置密码', () => {
  beforeEach(() => rpcMock.mockReset())

  describe('临时密码生成', () => {
    it('默认 14 位，四类字符各至少一个', () => {
      for (let round = 0; round < 50; round += 1) {
        const password = generateTemporaryPassword()
        expect(password).toHaveLength(14)
        expect(password).toMatch(/[a-z]/)
        expect(password).toMatch(/[A-Z]/)
        expect(password).toMatch(/[0-9]/)
        expect(password).toMatch(/[!@#%*\-_=+]/)
      }
    })

    it('不含口头转述或手抄时容易弄错的字符', () => {
      for (let round = 0; round < 50; round += 1) {
        // 数字去掉 0/1/2/5/8，字母去掉 O/I/S/Z/B 与 o/i/l/s/z；
        // 小写 b 保留 —— 它只和数字 8 像，而 8 已经不在字符集里。
        expect(generateTemporaryPassword()).not.toMatch(/[01258OISZBoilsz]/)
      }
    })

    it('每次结果不同，不是固定模板', () => {
      const drawn = new Set(Array.from({ length: 50 }, () => generateTemporaryPassword()))
      expect(drawn.size).toBe(50)
    })

    it('长度被夹在数据库允许的区间里', () => {
      expect(generateTemporaryPassword(4)).toHaveLength(TEMP_PASSWORD_MIN_LENGTH)
      expect(generateTemporaryPassword(500)).toHaveLength(TEMP_PASSWORD_MAX_BYTES)
      expect(validateTemporaryPassword(generateTemporaryPassword(500))).toBeNull()
    })
  })

  describe('前端预检', () => {
    it('拦住空值、过短、两端空格与超过 bcrypt 上限的输入', () => {
      expect(validateTemporaryPassword('')).toBe('请输入或生成临时密码')
      expect(validateTemporaryPassword('short1!')).toContain('至少')
      expect(validateTemporaryPassword(' Temp-Pass-9 ')).toContain('两端不能有空格')
      // 73 个汉字远超 72 字节：按字节判定，不是按字符数。
      expect(validateTemporaryPassword('密'.repeat(25))).toContain('72 字节')
    })

    it('合规密码不报错', () => {
      expect(validateTemporaryPassword('Temp-Pass-9xQ')).toBeNull()
    })
  })

  describe('错误码翻译', () => {
    it('把数据库的稳定错误码翻成可行动的中文', () => {
      expect(describeAdminPasswordResetError('WECHAT_ONLY_ACCOUNT')).toContain('微信')
      expect(describeAdminPasswordResetError('USER_NOT_FOUND')).toContain('账号不存在')
      expect(describeAdminPasswordResetError('PASSWORD_TOO_LONG')).toContain('72')
      expect(describeAdminPasswordResetError('PASSWORD_HAS_EDGE_SPACE')).toContain('空格')
      expect(describeAdminPasswordResetError('ADMIN role required')).toContain('只有管理员')
    })

    it('未收录的原因原样抛出，不吞掉真实信息', () => {
      expect(describeAdminPasswordResetError('connection refused')).toBe('connection refused')
    })
  })

  describe('RPC 调用', () => {
    it('转交目标账号与密码，并取出单行结果', async () => {
      rpcMock.mockResolvedValue({
        data: [{
          id: 'user-1',
          email: 'dev@example.com',
          display_name: 'dev',
          role: 'REVIEWER',
          email_confirmed_at: '2026-10-20T00:00:00Z',
          sessions_revoked: 2,
          reset_self: false,
        }],
        error: null,
      })

      await expect(adminResetUserPassword('user-1', 'Temp-Pass-9xQ')).resolves.toMatchObject({
        email: 'dev@example.com',
        sessions_revoked: 2,
        reset_self: false,
      })
      expect(rpcMock).toHaveBeenCalledWith('admin_reset_user_password', {
        p_user_id: 'user-1',
        p_password: 'Temp-Pass-9xQ',
      })
    })

    it('没有返回行时报错，而不是当成成功', async () => {
      rpcMock.mockResolvedValue({ data: [], error: null })
      await expect(adminResetUserPassword('user-1', 'Temp-Pass-9xQ')).rejects.toThrow('没有返回结果')
    })

    it('数据库报错原样抛给调用方翻译', async () => {
      rpcMock.mockResolvedValue({ data: null, error: { message: 'WECHAT_ONLY_ACCOUNT' } })
      await expect(adminResetUserPassword('user-5', 'Temp-Pass-9xQ')).rejects.toThrow('WECHAT_ONLY_ACCOUNT')
    })
  })
})
