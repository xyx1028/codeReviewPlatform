# 微信扫码登录与账号绑定

本函数接入微信开放平台“网站应用授权登录”，支持：

- 登录页微信扫码登录；首次使用时创建 Supabase Auth 用户。
- 邮箱老用户在“个人中心”绑定微信，后续微信登录仍进入原账号，角色和业务数据不变。
- 邮箱账号解绑微信；微信是唯一登录方式时禁止解绑，避免账号失联。

## 1. 微信开放平台准备

需要一个已审核通过并已开通微信登录能力的**网站应用**，取得 `AppID`、`AppSecret`，并配置授权回调域。

生产回调地址示例：

```text
https://<你的 Supabase 自定义域名>/functions/v1/wechat-auth/callback
```

`WECHAT_CALLBACK_URL` 必须与浏览器访问 `wechat-auth` 函数的入口同源，因为登录流程使用 `HttpOnly + SameSite=Lax` Cookie 绑定浏览器，防止登录 CSRF。微信开放平台通常要求使用已审核的自有回调域；建议为 Supabase 配置自定义域名，或通过同域网关代理整个 `/functions/v1/wechat-auth/*` 路径。

官方参考：[微信授权登录](https://developers.weixin.qq.com/doc/oplatform/developers/dev/auth/)。

## 2. 应用数据库迁移

```bash
supabase db push
```

迁移 `0013_wechat_identity.sql` 创建两张不向 `anon/authenticated` 开放的私有业务表：

- `wechat_identity`：微信身份到 `auth.users.id` 的一对一映射。
- `wechat_oauth_attempt`：10 分钟有效、使用后即删除的 OAuth 请求。

## 3. 配置 Edge Function Secrets

```bash
supabase secrets set \
  WECHAT_APP_ID='你的 AppID' \
  WECHAT_APP_SECRET='你的 AppSecret' \
  WECHAT_CALLBACK_URL='https://<域名>/functions/v1/wechat-auth/callback' \
  ALLOWED_ORIGINS='https://<前端域名>'
```

`SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY` 由 Supabase 平台注入。禁止把 `WECHAT_APP_SECRET` 或 service role key 写入任何 `VITE_*` 变量。

本地开发可使用未提交的 `supabase/functions/.env.local`：

```dotenv
WECHAT_APP_ID=...
WECHAT_APP_SECRET=...
WECHAT_CALLBACK_URL=http://127.0.0.1:54321/functions/v1/wechat-auth/callback
ALLOWED_ORIGINS=http://localhost:5173
ALLOW_LOCAL_ORIGINS=true
```

## 4. 部署公开函数

登录发起和微信回调发生在用户尚未取得 Supabase JWT 时，因此必须关闭函数网关的 JWT 前置校验；函数会对个人中心的绑定、解绑接口自行校验用户 JWT。

仓库的 `supabase/config.toml` 已固定 `[functions.wechat-auth] verify_jwt = false`；部署时仍显式保留参数，防止不同 CLI/流水线忽略本地配置：

```bash
supabase functions deploy wechat-auth --no-verify-jwt
```

## 5. 打开前端功能

在前端 `.env.local` 增加：

```dotenv
VITE_WECHAT_LOGIN_ENABLED=true
```

重新构建前端后，登录页显示“微信扫码登录”，左侧导航显示“个人中心”。开关关闭时个人中心仍可访问，但会提示微信登录未启用。

## 安全边界

- AppSecret、微信 access token、openid、unionid 不返回浏览器，也不写日志。
- 微信标识表启用 RLS 且撤销普通角色权限，仅 service role 可访问。
- 生产环境只接受 `ALLOWED_ORIGINS` 显式列出的 HTTPS 地址；localhost 仅在 `ALLOW_LOCAL_ORIGINS=true` 时启用。
- 登录 OAuth 使用随机 state、HttpOnly Cookie 和浏览器 session nonce 三重绑定。
- 绑定扫码只生成短期 handoff，必须回到发起绑定的原 Supabase 登录账号二次确认，转发二维码不会完成绑定。
- 回调地址和前端返回地址均限制在 `ALLOWED_ORIGINS`。
- URL 中仅携带短期一次性 handoff；Supabase `token_hash` 通过受控 POST 兑换，使用后立即失效且不进入 URL。
- 解绑前必须重新验证当前邮箱密码；微信唯一登录账号不能解绑。

Supabase 一次性链接与兑换机制参考：[Admin generateLink](https://supabase.com/docs/reference/javascript/auth-admin-generatelink) 和 [verifyOtp](https://supabase.com/docs/reference/javascript/auth-verifyotp)。

> 文档内容已基于官方资料重新表述，以符合许可要求。
