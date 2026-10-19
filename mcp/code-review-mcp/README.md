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

两个工具：`lookup_requirement`（只读查需求，不花钱）和 `start_requirement_review`（提交）。
提交是**两步**的 —— 先核对并让用户确认，再带令牌真正提交，见下面「提交前核对与确认」。
不提供进度查询、结果查询、轮询或自动等待：进度和结论都在平台页面上看。

## 它返回什么

成功时回执里有：批次编号、**任务受理编号（需求导入单 id）**、需求编号与提交参数、
批次详情链接，以及固定提示语「评审任务已提交，执行需要较长时间，请前往代码评审平台查看进度和结果。」

受理编号刻意用**导入单 id** 而不是分析任务 id：分析任务是需求快照冻结完成后由平台自动创建的，
提交那一刻它还不存在。回一个"看起来像 job id"的东西，只会让使用者拿着查不到的编号去平台里找。

提交失败时回的是错误文本，不含链接、不含"已提交"字样，并且平台上不会留下空批次
（创建批次后导入单下不去时会把刚建的批次删掉）。

## 部署

公司 Linux 现在由统一应用镜像运行 MCP：`Dockerfile.workercompany` 在 CI 构建期打包本目录源码与锁定依赖，
`deploy/supabase-selfhost/docker-compose.mcp.yml` 用该镜像启动独立容器，
`deploy/supabase-selfhost/scripts/release.sh --apply` 会随 Worker/Web 一起更新并检查 MCP。
首次正式发布会自动创建 MCP 专用 REVIEWER 系统账号及 `.docker/mcp.selfhost.env`，随机密码和调用凭证只留在该文件；默认模型 `glm5.3-flash` 由初始化脚本解析成准确配置 id。重复发布不会重置身份或凭证，具体步骤见
[`deploy/supabase-selfhost/README.md`](../../deploy/supabase-selfhost/README.md)。
下面的 `npm start` 用于源码直接运行或本地调试；旧的 systemd 示例是另一种部署方式，不应和容器同时占用 8848。

```bash
cd mcp/code-review-mcp
npm install
cp .env.example .env     # 然后按下表填写
npm start                # 或在仓库根目录 npm run mcp:start
```

启动时会自动加载**本目录的 `.env`**，不需要再 `set -a && . ./.env`。真实环境变量优先：
容器用 `--env-file`、systemd 用 `EnvironmentFile` 注入时，不会被仓库里这份文件盖掉；
已经用 `node --env-file=...` 指过文件时也不会再叠加 `.env`（两份配置混在一起比报错更难查）。
要换路径用 `CRP_MCP_ENV_FILE=/etc/codereview-mcp/.env`，指了但文件不存在会直接启动失败。

需要一个常驻进程（pm2 / launchd / systemd / Docker 均可）。同事要能从网络上访问到
`CRP_MCP_HOST:CRP_MCP_PORT`：局域网直连、VPN，或由反向代理（建议 Nginx/Caddy + HTTPS）转发。

需要 Node ≥ 20.12（用到 `process.loadEnvFile`）。

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `CRP_SUPABASE_URL` | ✅ | 平台 Supabase 地址（与前端同一个项目） |
| `CRP_SUPABASE_ANON_KEY` | ✅ | anon key。**不要用 service-role key** |
| `CRP_EMAIL` / `CRP_PASSWORD` | ✅ | 代表这台 MCP 的平台账号，角色必须是 ADMIN 或 REVIEWER |
| `CRP_PLATFORM_WEB_URL` | ✅ | 平台前端地址，用来拼批次详情链接 |
| `CRP_MCP_TOKENS` | ✅（HTTP 模式） | 访问凭证清单：`张三:至少16位随机串,李四:另一串`。名字只写进日志 |
| `CRP_DEFAULT_MODEL` | 平台有多个可用模型时必填 | 评审模型展示名或 id。调用方不能指定模型 |
| `CRP_MCP_HOST` / `CRP_MCP_PORT` / `CRP_MCP_PATH` | ❌ | 默认 `0.0.0.0` / `8848` / `/mcp`。路径会归一化，写成 `/mcp/` 也行 |
| `CRP_MCP_TRANSPORT` | ❌ | `http`（默认）或 `stdio`（本机自测用） |
| `CRP_MCP_ALLOW_NO_AUTH` | ❌ | `true` 时放弃鉴权校验。只用于内网自测，启动会打警告 |
| `CRP_MCP_ENV_FILE` | ❌ | 显式指定 `.env` 路径；相对路径按启动时的工作目录解析 |
| `CRP_MCP_ALLOWED_ORIGINS` | ❌ | 浏览器来源白名单，逗号分隔，默认 `*`。只影响 CORS 头，不替代鉴权 |
| `CRP_MCP_SESSION_TTL_MS` | ❌ | 空闲会话回收时间，默认 `1800000`（30 分钟），最小 60000 |
| `CRP_MCP_MAX_SESSIONS` | ❌ | 并发会话上限，默认 `256`。到上限时挤掉最久没活动的那个 |
| `CRP_PLATFORM_TIMEOUT_MS` | ❌ | 单次平台请求超时，默认 `20000` |
| `CRP_SETTLE_PROBES` / `CRP_SETTLE_PROBE_TIMEOUT_MS` / `CRP_SETTLE_DELAY_MS` | ❌ | 「结果不明」后的核对预算，默认 `3` / `8000` / `2000` |
| `CRP_BATCH_NAME_PREFIX` | ❌ | 批次名前缀，默认 `MCP 评审` |
| `CRP_TIMEZONE` | ❌ | 发布周期编码所用时区，默认 `Asia/Shanghai`。容器通常是 UTC，用本地时间会让编码比创建时间差 8 小时、早上 8 点前还错一天 |
| `CRP_LINKY_API_BASE_URL` | ❌ | 提交前核对需求用的 Linky 取数地址。**默认已指向公司地址**；显式设成空字符串才关闭核对 |
| `CRP_LINKY_TIMEOUT_MS` | ❌ | 单次核对请求超时，默认 `8000` |
| `CRP_CONFIRM_TTL_MS` | ❌ | 确认令牌有效期，默认 `900000`（15 分钟），最小 60000 |
| `CRP_CONFIRM_SECRET` | 多实例部署时必填 | 令牌签名密钥。留空则每次启动随机生成（重启后旧令牌失效）；多实例必须配同一个值 |

生成一串凭证：

```bash
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

### 两个运行期约束

**会话会被回收。** Streamable HTTP 的会话只在客户端显式发 `DELETE` 时才关闭，而 Codex /
Claude Code / Qoder 这类客户端进程退出时通常直接走掉。所以这里按"最后一次活动"计时，
超过 `CRP_MCP_SESSION_TTL_MS` 就回收（日志 `session_evicted`，`reason=IDLE_TIMEOUT`），
到 `CRP_MCP_MAX_SESSIONS` 时挤掉最久没活动的那个（`reason=MAX_SESSIONS`）。被回收的会话
再用会收到 400「缺少有效的 Mcp-Session-Id」，客户端重新 `initialize` 即可。
不回收的话，一个常驻服务会按"客户端启动次数"无上限地堆积会话。

**超时预算必须小于调用方客户端的超时**（多数 MCP 客户端默认 60 秒）。最坏路径是：

```text
CRP_PLATFORM_TIMEOUT_MS
  + CRP_SETTLE_PROBES × CRP_SETTLE_PROBE_TIMEOUT_MS
  + (CRP_SETTLE_PROBES - 1) × CRP_SETTLE_DELAY_MS
= 20s + 3×8s + 2×2s = 48s
```

超出客户端上限的后果不是慢，而是使用者看到一句 `tool call failed` ——
连批次编号都没有，而平台可能已经受理了。调大任何一项之前先算这笔账。

### 自检

```bash
curl -s http://127.0.0.1:8848/healthz
npm run live-check -- --url http://127.0.0.1:8848/mcp --token <凭证>          # 只读

# 只跑"提交前核对"这一步，看那张确认卡片；不会创建评审、不花额度
npm run live-check -- --url http://127.0.0.1:8848/mcp --token <凭证> --submit \
  --story US-2026-017341 --branch feature_dev --window 7

# 看过卡片、确认无误之后，再加 --confirm 才真的提交
npm run live-check -- --url http://127.0.0.1:8848/mcp --token <凭证> --submit --confirm \
  --story US-2026-017341 --branch feature_dev --window 7
```

`--workspace` 可选：项目组由平台按需求编号反查。只有 `--confirm` 才会真的提交并消耗模型额度。

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

> 帮我把 US-2026-017341 提交评审，分支 feature_dev，看最近 7 天的提交。

项目组不用说 —— 平台会按编号反查，并在你说错时纠正。客户端会先把查到的需求给你确认，
确认之后才真的提交。

## 工具契约

### `lookup_requirement`（只读，不花钱）

| 参数 | 必填 | 取值 |
|---|---|---|
| `story_code` | ✅ | 需求编号，一次一条 |
| `workspace_name` | ❌ | 用户说的项目组；填了会和实际值核对并在不一致时指出 |
| `branch` | ❌ | 与 `commit_window_days` 同时填，才会签出可直接提交的令牌 |
| `commit_window_days` | ❌ | 同上 |

### `start_requirement_review`

| 参数 | 必填 | 取值 |
|---|---|---|
| `story_code` | ✅ | 需求编号，一次一条 |
| `branch` | ✅ | `feature_dev` / `feature_sit` / `release` |
| `commit_window_days` | ✅ | `7` / `14` / `21` / `28` |
| `workspace_name` | ❌ | **可选** —— 平台按编号反查。填错会被纠正并在卡片上指出 |
| `workspace_id` | ❌ | 项目组 UUID，不确定就不要填 |
| `confirmation_token` | 第二次调用必填 | 第一次调用返回的令牌。带上它这次才真的提交 |

分支和提交窗口会直接改变评审结论，所以仍然必填、没有默认值 —— 静默替一个默认值比报错更糟。
模型不开放给调用方，由服务端 `CRP_DEFAULT_MODEL` 决定。

## 提交前核对与确认（V1.56）

提交是**两步**的，这是强制的：

```text
第一次调用（不带 confirmation_token）
  → 按编号从 Linky 查出真实需求：名称/项目组/状态/迭代/发布窗口/三类负责人/正文与附件有无
  → 纠正给错的项目组名（明确写出"你给的"与"实际是"）
  → 返回确认卡片 + confirmation_token
  → **不创建任何批次、不消耗模型额度**

第二次调用（带 confirmation_token）
  → 校验令牌签的就是这组参数
  → 建批次 + 下导入单，返回回执
```

为什么做成服务端门禁而不是写在工具描述里：工具描述约束不了模型的实际行为，而每次误提交
都是一个真实批次加一份模型额度。令牌用 HMAC 把四个关键参数和核对结论一起签进去，
改任何一个都失效，默认 15 分钟过期。

这一版修的是一次真实事故：使用者把项目组说成「工具组」（真名「工具开发组」），
上游对不存在的工作区**返回空列表而不是报错**，于是 MCP 照常受理、建了批次、回了
"✅ 已成功受理"，几十秒后平台侧以 `LINKY_NETWORK_ERROR 勾选的 1 条需求全部导入失败` 收场
—— 而那既不是网络问题，也没有真的受理成功。

三种核对结论对应三种行为：

| 结论 | 什么时候 | 行为 |
|---|---|---|
| 核对通过 | 查到需求 | 回卡片 + 令牌；项目组按实际值纠正 |
| **拒绝** | 编号查不到，**且上游自身健康** | 不建批次、不签令牌，如实报编号找不到 |
| **未核对** | MCP 不在内网 / 上游凭据失效 / 未配 `CRP_LINKY_API_BASE_URL` | 仍回卡片 + 令牌，但明确写"这次没核对成"，回执里也保留这个事实 |

最后一行是刻意的：**核对不可用不该堵死整条链路**，但也绝不许把"没核对"说成"核对过了"。
另外"编号查不到"只在上游健康时才算坏参数 —— 上游凭据失效时按编号查询可能根本没走完，
那时候拒绝提交等于拿上游的故障去否认一条真实的需求。

## 安全模型

- **客户端永远拿不到平台密钥。** service-role key、模型 API Key、Linky 凭证都不在这个进程的
  对外出口上：MCP 只用 anon key + 平台账号 JWT 调既有 RPC，回给客户端的只有编号、参数和链接。
- **平台权限照常生效。** 账号角色不够时提交会被 RLS 拒绝（实测 VIEWER 账号报
  `review_batch` 的 row-level security 违例），MCP 如实回错，不会绕过。
- **凭证在 HTTP 层先校验**，没过连 `initialize` 都不处理，回 401 + `WWW-Authenticate`。
  例外只有两处且都不涉及身份：`/healthz`，以及 `OPTIONS` 预检 —— 浏览器不会给预检请求带
  `Authorization`，按业务流程先鉴权会把它打成 401，客户端那边只显示"连不上"。
- **CORS 放开不等于鉴权放开**：凭证走 `Authorization` 头而不是 cookie，跨站脚本拿不到它，
  所以 `Access-Control-Allow-Origin` 不会把身份借给别的站点；这里也刻意不回
  `Access-Control-Allow-Credentials`。需要收紧时用 `CRP_MCP_ALLOWED_ORIGINS` 列白名单。
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
404、tools/list 只有一个工具、tools/call 的调用方身份传递；加固测试覆盖尾斜杠路径、
`OPTIONS` 预检与 CORS 头、匿名模式、空闲会话回收、会话上限挤出、端口占用时 `listen()` 必须
reject、`.env` 加载与优先级、`.env.example` 与实际读取的变量不漂移、同毫秒并发的
`week_code` 不相撞、核对探针的独立超时。
