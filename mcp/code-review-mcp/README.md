# codereview-mcp：远程 MCP 提交指定需求的代码评审

公司同事在 Qoder / Codex / Claude Code 等客户端里填一个 MCP 地址和一串访问凭证，就能通过
对话把**公司内任意一条需求**提交到「需求开发评审一致性平台」做代码评审，不限制需求负责人。

```text
同事的 AI 客户端
  └─ Streamable HTTP + Bearer 凭证 ─► 这台 MCP 服务（你部署，常驻）
        └─ Supabase anon key + 平台账号 JWT ─► 平台既有 RPC
              建批次 → request_linky_batch_import_for_analysis   ← 到这里就返回回执
                    └─ Worker 内网取 Linky 正文/附件并冻结 → 自动建分析任务 → Agent 评审
```

首版**只有一个工具** `start_requirement_review`：提交并返回回执，不提供进度查询、结果查询、
轮询或自动等待。进度和结论都在平台页面上看。

## 它返回什么

成功时回执里有：批次编号、**任务受理编号（需求导入单 id）**、需求编号与提交参数、
批次详情链接，以及固定提示语「评审任务已提交，执行需要较长时间，请前往代码评审平台查看进度和结果。」

受理编号刻意用**导入单 id** 而不是分析任务 id：分析任务是需求快照冻结完成后由平台自动创建的，
提交那一刻它还不存在。回一个"看起来像 job id"的东西，只会让使用者拿着查不到的编号去平台里找。

提交失败时回的是错误文本，不含链接、不含"已提交"字样，并且平台上不会留下空批次
（创建批次后导入单下不去时会把刚建的批次删掉）。

## 部署

```bash
cd mcp/code-review-mcp
npm install
cp .env.example .env     # 然后按下表填写
set -a && . ./.env && set +a
npm start
```

需要一个常驻进程（pm2 / launchd / systemd / Docker 均可）。同事要能从网络上访问到
`CRP_MCP_HOST:CRP_MCP_PORT`：局域网直连、VPN，或由反向代理（建议 Nginx/Caddy + HTTPS）转发。

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `CRP_SUPABASE_URL` | ✅ | 平台 Supabase 地址（与前端同一个项目） |
| `CRP_SUPABASE_ANON_KEY` | ✅ | anon key。**不要用 service-role key** |
| `CRP_EMAIL` / `CRP_PASSWORD` | ✅ | 代表这台 MCP 的平台账号，角色必须是 ADMIN 或 REVIEWER |
| `CRP_PLATFORM_WEB_URL` | ✅ | 平台前端地址，用来拼批次详情链接 |
| `CRP_MCP_TOKENS` | ✅（HTTP 模式） | 访问凭证清单：`张三:至少16位随机串,李四:另一串`。名字只写进日志 |
| `CRP_DEFAULT_MODEL` | 平台有多个可用模型时必填 | 评审模型展示名或 id。调用方不能指定模型 |
| `CRP_MCP_HOST` / `CRP_MCP_PORT` / `CRP_MCP_PATH` | ❌ | 默认 `0.0.0.0` / `8848` / `/mcp` |
| `CRP_MCP_TRANSPORT` | ❌ | `http`（默认）或 `stdio`（本机自测用） |
| `CRP_MCP_ALLOW_NO_AUTH` | ❌ | `true` 时放弃鉴权校验。只用于内网自测，启动会打警告 |
| `CRP_BATCH_NAME_PREFIX` | ❌ | 批次名前缀，默认 `MCP 评审` |

生成一串凭证：

```bash
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

### 自检

```bash
curl -s http://127.0.0.1:8848/healthz
npm run live-check -- --url http://127.0.0.1:8848/mcp --token <凭证>          # 只读
npm run live-check -- --url http://127.0.0.1:8848/mcp --token <凭证> --submit \
  --workspace "灵基Foundation" --story F-123456 --branch feature_dev --window 21
```

`--submit` 会真的提交一次评审并消耗模型额度。

## 客户端怎么配

地址填 `http(s)://<你的主机>:8848/mcp`，鉴权填 `Authorization: Bearer <凭证>`
（只支持自定义头的客户端也可以用 `X-Api-Key: <凭证>`）。

下面的字段名都对过各客户端官方文档。**注意 `type` 的值是 `http` / `streamable-http`
（小写、连字符），不是驼峰的 `streamableHttp`** —— 写错会被当成 stdio 服务器，连不上。

Qoder（Settings → MCP → My Servers → + Add，或 `~/.qoder/settings.json`）：

```json
{
  "mcpServers": {
    "code-review": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer 你的凭证" }
    }
  }
}
```

Claude Code（`.mcp.json` / `~/.claude.json`，`type` **不能省**，省了会被当 stdio）：

```bash
claude mcp add --transport http code-review https://mcp.example.com/mcp \
  --header "Authorization: Bearer 你的凭证"
```

```json
{
  "mcpServers": {
    "code-review": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer 你的凭证" }
    }
  }
}
```

Cursor（`.cursor/mcp.json`，官方远程示例不带 `type`，靠有没有 `url` 判定远程）：

```json
{
  "mcpServers": {
    "code-review": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer 你的凭证" }
    }
  }
}
```

Codex CLI（`~/.codex/config.toml`，TOML 没有 `type` 键；官方首选让 Bearer 走环境变量）：

```toml
[mcp_servers.code_review]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "CODE_REVIEW_MCP_TOKEN"   # 另在环境里设这个变量
```

```toml
# 或者直接写死 header
[mcp_servers.code_review]
url = "https://mcp.example.com/mcp"
http_headers = { Authorization = "Bearer 你的凭证" }
```

依据：[Qoder CLI MCP reference](https://docs.qoder.com/cli/mcp-reference)、
[Claude Code MCP](https://code.claude.com/docs/en/mcp/)、
[Cursor MCP](https://cursor.com/docs/context/mcp)、
[Codex MCP](https://developers.openai.com/codex/extend/mcp)。客户端升级后字段可能变，
以各自文档为准；这台服务需要的只有两样：**URL 和一个 Bearer 头**。

配好之后直接说人话即可，例如：

> 帮我把 F-123456 提交评审，项目组是灵基Foundation，分支 feature_dev，看最近 21 天的提交。

## 工具契约

`start_requirement_review`

| 参数 | 必填 | 取值 |
|---|---|---|
| `workspace_name` | ✅ | 需求所在项目组名称（Linky 的 workspace_name） |
| `story_code` | ✅ | 需求编号，一次一条 |
| `branch` | ✅ | `feature_dev` / `feature_sit` / `release` |
| `commit_window_days` | ✅ | `7` / `14` / `21` / `28` |
| `workspace_id` | ❌ | 项目组 UUID，不确定就不要填 |

四个必填参数没有默认值：目标分支和提交窗口会直接改变评审结论，静默替一个默认值比报错更糟。
模型不开放给调用方，由服务端 `CRP_DEFAULT_MODEL` 决定。

## 安全模型

- **客户端永远拿不到平台密钥。** service-role key、模型 API Key、Linky 凭证都不在这个进程的
  对外出口上：MCP 只用 anon key + 平台账号 JWT 调既有 RPC，回给客户端的只有编号、参数和链接。
- **平台权限照常生效。** 账号角色不够时提交会被 RLS 拒绝（实测 VIEWER 账号报
  `review_batch` 的 row-level security 违例），MCP 如实回错，不会绕过。
- **凭证在 HTTP 层先校验**，没过连 `initialize` 都不处理，回 401 + `WWW-Authenticate`。
- **会话与凭证绑定**：拿到 `Mcp-Session-Id` 换一个凭证继续用会被 403，否则 session id 就等于
  绕过了鉴权。
- **调用方身份不由模型提供**：它取自校验通过的凭证名，写进 stderr 日志和批次备注。
- 所有调用方共用同一个平台账号，批次的 `created_by` 是这个账号；要区分"谁提交的"看批次备注
  里的凭证名。**凭证等于能消耗模型额度**，按人发放、泄露就从 `CRP_MCP_TOKENS` 里删掉重启。
- 暴露到局域网之外请套 HTTPS。明文 HTTP 上的 Bearer 凭证等于公开。

## 测试

```bash
npm test     # node --test：配置/鉴权/参数校验/受理回执/失败补偿 + 真实 Streamable HTTP 协议往返
```

协议测试用 MCP 官方客户端连一个真的 HTTP 端点，覆盖 401、403（会话串用）、400（缺会话 id）、
404、tools/list 只有一个工具、tools/call 的调用方身份传递。
