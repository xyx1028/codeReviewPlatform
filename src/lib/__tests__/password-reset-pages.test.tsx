import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { App as AntApp } from 'antd'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForgotPasswordPage, ResetPasswordPage } from '../../App'
import { captureRecoveryLanding, clearRecoveryFlow } from '../password-recovery'

/**
 * 两个新页面的静态渲染（和 AcceptanceReviewCard 用例同一个路子：renderToStaticMarkup，
 * 不引 DOM）。它证明的是"每种状态渲染出来的文案是对的"，不替代浏览器里的人工走查。
 */
function render(node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(
        MemoryRouter,
        { initialEntries: ['/reset-password'] },
        createElement(AntApp, null, node),
      ),
    ),
  )
}

/** 模拟"浏览器刚打开重置链接"：先摆好 URL，再按真实顺序抄一次落地信息。 */
function landOnResetPassword(hash: string): void {
  vi.stubGlobal('window', { location: { pathname: '/reset-password', hash, search: '' } })
  captureRecoveryLanding()
}

describe('V1.64 忘记密码页面渲染', () => {
  afterEach(() => {
    clearRecoveryFlow()
    vi.unstubAllGlobals()
  })

  it('发起页给出邮箱表单、微信账号说明和返回登录', () => {
    const html = render(createElement(ForgotPasswordPage))
    for (const text of ['找回密码', '邮箱', '发送重置邮件', '返回登录', '微信扫码登录即可']) {
      expect(html).toContain(text)
    }
  })

  it('有恢复会话时渲染新密码与确认密码，并提示全设备重新登录', () => {
    landOnResetPassword('#access_token=token&type=recovery')
    const html = render(createElement(ResetPasswordPage, { hasSession: true }))
    for (const text of ['设置新密码', '新密码', '确认新密码', '所有设备都需要用新密码重新登录', '放弃并返回登录']) {
      expect(html).toContain(text)
    }
  })

  it('链接过期时只给重新发起的入口，不渲染一个提交必然失败的表单', () => {
    landOnResetPassword('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=')
    const html = render(createElement(ResetPasswordPage, { hasSession: false }))
    expect(html).toContain('重置链接不可用')
    expect(html).toContain('重置链接已过期或已被使用过，请重新发起找回密码。')
    expect(html).toContain('重新发起找回密码')
    expect(html).not.toContain('确认新密码')
  })

  it('没有任何恢复凭据时同样不渲染新密码表单', () => {
    landOnResetPassword('')
    const html = render(createElement(ResetPasswordPage, { hasSession: false }))
    expect(html).toContain('没有找到有效的重置链接')
    expect(html).not.toContain('确认新密码')
  })
})
