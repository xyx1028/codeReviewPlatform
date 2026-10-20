# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## AI Automation Worker

The background analysis Worker lives under `worker/` and builds independently of
the frontend. It polls Supabase, freezes the four whitelisted repositories at
exact commit SHAs, and runs one DeepSeek Harness ACP attempt per claimed Story
Task. On V4 each attempt drives a **multi-agent tree** (a root reviewer that may
spawn/fork research, implementation, critic and workflow children) with the full
Harness capability set **enabled by default** — Sandbox Shell, Filesystem, Web
egress, Workflow/Subagent/Jobs, parallel tools, auto-compaction and JSONL
session persistence. Capabilities are a user-facing default; operators narrow
them only during incidents via emergency breaker env vars
(`V4_BREAKER_DISABLE_WEB` / `_SHELL_WRITE` / `_SUBAGENTS` / `_WORKFLOW`).

Snapshot reads still go through Broker-controlled, read-only tools bound to the
pinned commit; only the root agent can submit through `submit_review_result`;
and every result is committed through canonical service-role RPCs. The resolved
tool inventory is validated against the frozen
`worker/harness/code-review-acp/v4-capability-contract.json`.

Session JSONL transcripts persist on a **named volume** (`AGENT_SESSION_ROOT`,
default `/workspace/agent-sessions`, 0700, encrypt at rest) so a restarted Worker
can resume an uncommitted session; concurrent writes are fenced by a local
single-writer lock plus database `session_revision`.

Scripts:

```bash
npm run worker:typecheck            # tsc -p tsconfig.worker.test.json (type check only)
npm run worker:build                # tsc -p tsconfig.worker.json  -> dist-worker/
npm run worker:start                # node dist-worker/index.js
npm run worker:check-connectivity   # GitLab + Supabase/Vault + minimal model ping
npm run worker:dev                  # tsx worker/src/index.ts
npm run test:worker                 # vitest run worker
npm run test:web                    # vitest run -c vitest.web.config.ts（前端纯逻辑）
npm run web:typecheck               # tsc -p tsconfig.web.test.json（前端测试文件的类型检查）
npm test                            # harness:manifest:check + 全部 vitest 用例
```

One-command container deployment (default 4 replicas × 2 story slots = capacity
8; persistent Session/cache volumes are declared in the compose file):

```bash
docker compose -f docker-compose.worker.yml up -d --scale worker=4
```

See `worker/OPERATIONS.md` (§15 covers V4: full env/secret checklist,
retention and disk alerts, RPM/TPM/cost alerts, orphan checks with SQL, session
corruption and web egress runbooks, emergency breakers, scaling/rolling restart,
the §12 production cutover/rollback principles, the §9 error-code table, the log
field allowlist, and audit queries for the new tables) for the full runbook.

## 真实运行监控台（V1.5）

管理员可以在 `/monitoring` 从正在运行的批次逐层下钻到
`批次 → Analysis Job → 需求任务 → Attempt → Agent Tree → 当前真实活动`。

页面上每一句「正在……」都对应一条**未闭合的** `phase='STARTED'` 事实事件与一行
`analysis_agent_node.current_activity_*` 投影；界面绝不根据计数增长、工具名称或超时
自行猜测阶段。没有后端事实的东西（Phase 3 之前的 Workflow 步骤与 Harness Job 实例树）
明确显示「不可展开」，而不是画一个看起来在动的进度条。

- 事件由 Worker 主动上报（`RUNTIME_EVENTS_ENABLED`，见 `.docker/worker.env.example`），
  经 `report_analysis_runtime_event_batch` 写入 append-only 的 `analysis_runtime_event`。
- 工具生命周期插桩在 `agent-authority-policy` 的 `tools/pre-execute`：这是覆盖全部 30 个
  模型工具（含 25 个不经过 Broker 的 harness origin 工具，例如 `bash` / `edit` / `grep`）
  的唯一边界。模型生命周期插桩在 `usage-reporter` 的 `metered()`。
- 首版**不改** `v4-capability-contract.json`：全部插桩通过扩展现有 Broker 路由的请求体
  实现，manifest 哈希不变，因此新旧 Worker 可以混跑同一批次，回滚只需要
  `RUNTIME_EVENTS_ENABLED=false` 滚动重启。
- 游标按 `xact_id` 提交水位裁剪（配 30 秒逃生阀），断线可完整补拉且并发写入下不跳号。
- 事件保留 30 天；`analysis_agent_run_rollup` 长期保留 —— 跨月的「优化前后对比」只能靠它。

AI 侧的取数通道是只读诊断 CLI（不经过前端，三个诊断 RPC 不授予 `authenticated`）：

```bash
npm run monitor:attempt -- --task <task_id> [--attempt N] [--format md|json]
npm run monitor:trend -- --group-by model_label,policy_hash --since 30d
npm run monitor:findings -- --since 7d
```

默认连本地 Supabase；查远端需要显式 `--remote` 并二次确认。输出开头固定打印
`instrumentation_health`（`events_dropped` / `unattributed_pct` / `timeline_truncated`），
先说清这份数据能不能采信，再给结论；输出前还会做一次敏感模式扫描，命中即拒绝输出。

`attempt` 子命令还会返回机器可读的 `instrumentation_gaps`，逐条列出**没有插桩**的部分
（Worker→Supabase 的 RPC 往返、Harness 内部编排、被 800ms 折叠掉的快工具 STARTED、
Phase 3 之前的 Workflow/Job 实例树）。它们全部落在 `unattributed_ms` 里 —— 这正是那个桶
存在的理由：宁可如实显示一部分时间无法解释，也不把它摊进其它桶假装归因完整。

运维面（环境变量、清理调度归属、三级停写、告警判据与 SQL、事件量与切分区时机、
上线顺序与验收清单）见 `worker/OPERATIONS.md` 第 16 节。

## 受管 DSH Skills（V1.6）

管理员在 `/skills` 维护多文件 Skill Bundle。链路是：

```text
上传 ZIP 到 staging → 服务端解析并生成规范 manifest → 发布成不可变版本
→ 新 Analysis Job 冻结全部「已发布且启用」的版本
→ Worker 按 bundle hash 复用共享 cache（miss 时 service-role 下载并三层校验）
→ 复制到 per-attempt DSH_HOME/skills/<name>/
→ dsh 首轮只披露 name + description，Agent 调用 skill(name) 后才读到 SKILL.md 正文
```

关键约束：

- **技能包不进代码 Workspace。** 它属于 dsh 运行配置，生命周期跟随 per-attempt
  `DSH_HOME`；Workspace 只放被评审代码、overlay、artifacts 和临时文件。
- **三层 hash 各自独立重算**：`archive_sha256`（字节完整）、`bundle_hash`（展开后的逻辑
  文件集合）、`skill_catalog_hash`（Job 冻结的集合身份）。Edge Function 与 Worker 各算一遍，
  数据库再算一遍 —— 三处共用一份**行式**规范格式，`collate "C"` 对齐 JS 的码元序。
- **`SKILL.md` 必须带 YAML frontmatter**（`name` 与技能名相同、`description` 非空）。
  dsh 的 `skill-filesystem` 缺了它只写一行 warn 就忽略整个技能 —— 文件在磁盘上、Job 也建成了，
  模型的目录里就是没有它，而平台侧没有任何错误码。所以发布时就拒。`description` 与
  `whenToUse` **只**来自 frontmatter，数据库里的那份是它的投影，不让管理员另敲一遍。
- **归档解析 fail closed**：Zip Slip、绝对路径、`..`、反斜杠、重复与大小写冲突路径、
  symlink / 设备 / FIFO / socket、加密归档、CRC 不符、Zip Bomb（20:1）、未在允许列表里的
  文件类型、非严格 UTF-8 文本、magic 与扩展名不符的图片，全部拒绝发布。禁止"先解压后检查"。
- **发布后不可覆盖**：version 行与正式对象都不可变；被 Job 快照引用即不可删除。
  发布 V2 只影响之后新建的 Job。
- **恢复门禁**：`profile hash` 与 `skill_catalog_hash` 都参与判定，不一致时以
  `SESSION_FORMAT_UNSUPPORTED` / `SESSION_SKILL_SET_MISMATCH` 拒绝恢复，绝不退化成空技能目录。
- **脚本不会因加载技能而执行**，但拥有 `bash` 的 Agent 可以显式运行；含 `scripts/` 的版本
  必须在发布页额外确认。

共享 cache 需要一个命名卷：

```bash
# docker-compose.worker.yml 已声明 worker-skill-cache:/workspace/skill-cache
SKILL_CACHE_ROOT=/workspace/skill-cache
SKILL_CACHE_MAX_BYTES=4294967296
```

上线顺序、错误码表、告警判据、清理归属与回滚见 `worker/OPERATIONS.md` 第 17 节；
上传服务的安全模型见
[`supabase/functions/skill-bundle-admin/README.md`](supabase/functions/skill-bundle-admin/README.md)。

## 用户故事直连 Linky（V1.20）

需求不再靠上传 Excel + 字段映射。两条路径刻意分开 —— 看板要**实时**，批次要**冻结**：

```text
看板 /stories
  浏览器直连 Linky 取数接口（打开即当前状态，正文与附件都是实时的，「刷新」就是重新请求）
  → 只读：筛项目组 / 发布窗口 / 迭代 / 状态 / 负责人，看正文，下载附件

批次「原始需求导入」
  选项目组 + 发布窗口 → 勾选需求 → 点「确认导入并冻结」
  → request_linky_batch_import 下一张导入单
  → Worker 第 5 条轮询在内网侧逐条取正文与附件字节
  → 冻结进 review_story(+_attachment) + 私有 bucket story-attachments（sha256 由平台算）
  → 下一步就是 AI 分析；分析时附件物化到 attempt workspace 的 requirements/<story>/
```

它解决的是三个具体缺陷，不是"换个入口"：

- **AI 之前经常看不到需求正文。** 冻结需求快照时取的是 Excel 行里字面叫「详细描述」的那一列，
  列名一变模型拿到的就只有标题加项目名。现在正文来自结构化字段（Linky 的
  `field_values.gf_description`），关联特性、迭代、发布窗口、需求/开发/测试负责人同样是字段而非猜测。
- **附件之前完全拿不到。** 验收口径大量躺在 `.docx` / `.html` / `.md` 附件里。看板可以实时下载；
  导入时附件字节随批次冻结，分析时物化进 workspace 让 Agent 自己读。实测还存在**正文为空、
  需求全写在 PRD 附件里**的故事；也存在只有标题的故事 —— 2026-09-24 起导入**不设内容门禁**，
  正文与附件都可以为空，代价是这类需求的一致性结论更弱，平台如实导入而不替使用者拦。
- **字段映射页整页删除。** 接口给的就是结构化数据，没有可映射的东西。

三条边界值得单独记住：

- **看板需要使用者连着公司内网/VPN。** 页面本身从公网加载，但取数接口只在内网可达
  （域名在内网 DNS 下解析到 `172.18.x.x`）。不在内网时看板会**明确报错**，而不是显示一个
  空列表假装没有需求。
- **导入不走浏览器。** 让前端把抓到的正文直接写库，等于让它提供"需求正文"这一评审输入，
  平台无从判断是否真的来自 Linky。所以前端只提交「组 + 窗口 + 勾选编号」，内容由 Worker 取。
  代价是确认后要等一次 Worker 轮询（默认 5 秒），页面有真实进度条。
- **容器化 Worker 必须经宿主机代理**（与 V1.7 内网模型同一条链路），且代理要放开 Linky 的
  2055/90 端口 —— 旧启动配置若仍仅允许 `80,443`，会表现为 `CONNECT tunnel failed, 403`。
- **能力契约没动**：附件走 workspace 文件而不是新工具，manifest revision 仍是 3，新旧 Worker 可混跑。

macOS 与 Windows 使用同一个宿主机代理安装入口（需已安装 Node.js，仓库中已有 `.docker/worker.env`）：

```sh
npm run proxy:model-vpn:install
# 停用服务，保留配置与日志以便重新安装
npm run proxy:model-vpn:uninstall
```

安装入口是 `scripts/model-vpn-proxy-service.mjs`，自动选择 macOS launchd 或 Windows
当前用户的计划任务；两端与代理直接启动的默认端口统一为 `80,443,2055,90`。macOS 使用
launchd `KeepAlive`；Windows 同时注册主代理任务和 `codereviewplatform-model-vpn-proxy-watchdog`
守护任务。守护任务每分钟探测 `127.0.0.1:17890`：端口健康时不操作，端口不可达时启动主任务；
如果主任务仍显示运行则先停止再启动。因此外部终止或僵死后，恢复窗口最长一分钟，且不会重复启动
健康代理。守护任务固定使用当前系统的 `WindowsPowerShell` 绝对路径，并以 `0` 表示检查完成、
`1` 表示可诊断的检查失败；因手工停止、重装替换而出现的 `0xFFFFFFFF` 不是健康检查的正常结果。
Windows 请使用运行 Worker 的同一用户；若任务注册被系统权限策略拒绝，再使用该用户的
管理员终端。Windows 服务在用户登录时启动，注销后不保证运行，不是无人登录的系统服务。
重新安装会更新固定主任务 `codereviewplatform-model-vpn-proxy`、守护任务
`codereviewplatform-model-vpn-proxy-watchdog`，并停用已知的另一个旧任务
`CodeReviewPlatform-ModelVpnProxy`（保留其定义供恢复），避免下次登录同时启动。其他名字的手工
任务不会被自动处理。已有代理凭据会从 `.docker/worker.env` 复用。
安装成功只代表服务已注册并请求启动；还需检查日志中的 `proxy_started` 并验证模型/Linky 请求。
Windows 日志：`%LOCALAPPDATA%\CodeReviewPlatform\model-vpn-proxy\model-vpn-proxy.log`；
macOS 日志：`~/Library/Logs/codereviewplatform/model-vpn-proxy.log`。
若更改了 Worker 的代理地址或凭据，需要重建/重启相关 Worker 容器以加载配置。

运维面（env 清单、代理端口、导入队列 SQL、错误码表、孤儿附件回收、回滚、复跑验证命令）见
`worker/OPERATIONS.md` 第 21 节。

## 需求全量上下文（V1.21）

AI 分析一条需求时，"需求那一侧"的全部冻结事实都会送到模型面前，分三层：

```text
提示词（第一眼就看到）
  需求编号 / 需求名称 / 所属项目 / 目标分支
  需求字段：来源、状态、迭代、发布窗口、关联特性、开发/需求/测试负责人、源系统链接
  需求正文、验收标准（有就给）
  → 指向 requirements/<story>/需求快照.md，要求开始检索代码之前先读
  → 列出附件路径，并明确「必须在下结论之前全部读过，正文与附件冲突时以附件为准」

requirements/<story>/需求快照.md（平台写，模型自己 read）
  上面全部字段 + 源系统原始字段原文（Linky field_values / Excel 整行）+ 附件清单

requirements/<story>/<附件原名>（随快照冻结的字节，sha256 校验通过才落盘）
```

它修掉的是一个静默缺口：`review_story` 里的迭代、发布窗口、需求状态、三类负责人、
源系统链接**早就冻结在库里**，但一个都没进提示词 —— 冻结函数只产出 5 个键，Worker 又
只取其中 3 个，而那 3 个里的 `release_window` 从来不存在于冻结上下文（死代码）。模型于是
只能看到编号、标题和正文，还是以 `detailed_description: xxx` 这种裸英文键给的。

三条边界：

- **大 JSON 不进提示词。** 源系统原始字段里有大量 UUID 与内部码，只写进快照文件；
  提示词只列人类可读的标量字段，顺序固定，未登记的键一律不进（V1.11 的白名单边界没有放开）。
- **附件从"可以读"改成"必须读"。** 以前是许可语气，实测存在正文只有一行、验收口径全在
  PRD 附件里的需求 —— 那种情况下模型会直接拿那一行去评审，而平台没有任何错误码能发现。
- **只影响之后新建的 Job。** `requirement_context` 与 `input_hash` 在冻结时算一次写库，
  读取不重算，所以历史批次、在途任务与 Session 续跑都不受影响；能力契约与 manifest
  哈希不变，新旧 Worker 可混跑。`prompt_version` 变成 `agent-review-v2.1`，监控台靠它
  区分改造前后。

运维面（新日志事件、确认全量生效的 SQL、回滚、复跑命令）见 `worker/OPERATIONS.md` 第 22 节。

## 远程 MCP 提交需求评审（V1.47）

同事不用打开平台页面：在 Qoder / Codex / Claude Code 里配一个 MCP 地址加一串访问凭证，
用对话就能把**公司内任意一条需求**（不限需求负责人）提交去评审。

```text
AI 客户端 ──Streamable HTTP + Bearer 凭证──► mcp/code-review-mcp（你部署，常驻）
                                              └─ anon key + 平台账号 JWT ─► 既有 RPC
                                                   建批次 → request_linky_batch_import_for_analysis
                                                        ↑ 到这里就返回回执（批次编号 + 受理编号 + 链接）
                                              之后 Worker 照原样：冻结需求 → 建分析任务 → Agent 评审
```

首版**只有一个工具** `start_requirement_review`，入参四个、都必填：项目组、需求编号、
目标分支（`feature_dev`/`feature_sit`/`release`）、提交时间窗口（7/14/21/28 天）。模型由服务端配置，
调用方不能指定。

**V1.66 起一次可以提交多条需求。** 用 `story_codes` 给编号列表（最多 20 条），它们进入
**同一个批次、同一张导入单**，共享一份代码快照，只确认一次、只回一张回执 —— 在此之前
想同时评审两条需求只能调两次，平台上就会出现两个各含一条需求的批次。代价是三条硬边界：
多条必须属于**同一个项目组**（导入单只有一个 workspace，跨组直接拒绝并逐条告知归属）；
任一编号确实不存在时**整次拒绝**而不是替你剔掉那条照常提交；上限 20 条来自提交前逐条
核对的耗时（详情端点未命中要 31.8 秒），更大批量仍然走页面上的「原始需求导入」。

**V1.56 起提交是两步的，而且项目组不用自己填。** 第一次调用只核对、不建批次：平台按需求编号
从 Linky 反查出它真正属于哪个项目组，连同名称、状态、迭代、发布窗口、三类负责人、正文与附件
有无一起返回，由使用者确认后，带着确认令牌再调一次才真正提交。这修的是一次真实事故 ——
使用者把项目组说成「工具组」（真名「工具开发组」），而上游对不存在的工作区**返回空列表
而不是报错**，于是批次建好了、回执说"已成功受理"，几十秒后平台侧才以
`LINKY_NETWORK_ERROR 全部导入失败` 收场；那句话既不是网络问题，也没有真的受理成功。
**V1.60 又补了三个只读查询工具**，因为调用方的模型看不到平台页面上的下拉框，不给它查的
途径它就只能猜：`list_workspaces`（有哪些项目组，说"工具组"能模糊查到"工具开发组"）、
`search_requirements`（按项目组列需求，用标题找编号；**V1.67 起还能按发布窗口筛**，
窗口写错或没填时会列出该组实际有哪些窗口、各多少条 —— 上游没有这个过滤参数，是平台
取回整组后在本地筛的）、`describe_submit_options`（代码基线/时间窗口/发布周期各自的
合法取值）。连同 `lookup_requirement` 共四个只读工具，都不消耗模型额度。

**V1.68 起可以直接评审一个发布窗口的全部需求**：给项目组 + 发布窗口
（`workspace_name` + `release_window`，最多 50 条），平台自己枚举那个窗口下的需求，
第一次调用把它们**逐条**列在确认卡片上，确认后第二次调用只带令牌即可，不必回传那一串编号。
令牌锁定的是**枚举出来的那一组编号**而不是"这个窗口"这个条件 —— Linky 是实时的，两次调用
之间新增的需求不会被悄悄带上。枚举不出来（取不到数、整组没翻完）或条数超限时**直接拒绝**，
不会只提交前 50 条让人以为整个窗口都在评审。

于是"评审这个发布窗口的需求"有两条路：直接给窗口让平台枚举；或者先用
`search_requirements` 查出编号给使用者挑，再用 `story_codes` 提交。两条都要经过
"逐条看过再确认"这道门禁 —— 按一个筛选条件批量花钱而使用者从没看过清单，是这个平台
一直拒绝做的事。

公司 Linux 的日常发布从同一 CI 镜像启动独立 MCP 容器；统一 `release.sh --apply` 会自动初始化
MCP 专用 REVIEWER 系统账号、随机凭证和默认 `glm5.3-flash` 模型配置，再同时更新 Worker、Web 和 MCP。
步骤见 [`deploy/supabase-selfhost/README.md`](deploy/supabase-selfhost/README.md)。
本地源码调试仍可使用：

```bash
npm run mcp:install
# 填好 mcp/code-review-mcp/.env（见该目录 README 的环境变量表）
npm run mcp:start
npm run mcp:live-check -- --url http://127.0.0.1:8848/mcp --token <凭证>   # 只读自检
```

三条边界值得单独记住：

- **受理编号是需求导入单 id，不是分析任务 id。** 分析任务由平台在需求快照冻结完成后自动创建，
  提交那一刻它还不存在（`analysis_status='PENDING'`、`analysis_job_id` 为 null）。回一个
  "看起来像 job id"的东西，只会让使用者拿着查不到的编号去平台里找。
- **首版不提供进度/结果查询，也不轮询。** 回执里给批次详情链接
  （`/batches/<id>/ai-result`），进度与结论只在平台页面上看 —— 对话里画一个没有后端事实的
  进度条，是这个平台一直拒绝做的事。
- **不绕过平台权限，也不交出任何密钥。** 只用 anon key + 平台账号 JWT，service-role key、
  模型 API Key、Linky 凭证都不在这条链路上；账号角色不够时提交会被 RLS 如实拒绝。
  凭证等于能消耗模型额度，按人发放，暴露到局域网外必须套 HTTPS。

运行期还有两件事会直接影响"同事能不能用"：**空闲会话按最后一次活动回收**
（客户端退出时多数不发 `DELETE`，不回收会无上限堆积），以及**工具调用的超时预算必须小于
调用方客户端的超时**（默认 20s + 3×8s + 2×2s = 48s，客户端通常是 60s）。两者都可配，
算式见 MCP 目录 README。

MCP 接口沿用现有表和 RPC，Worker 与能力契约没有变化。公司部署将 MCP 放进统一应用镜像，
所以 MCP 代码更新仍需 CI 重建该镜像，再执行统一发布脚本。完整配置、客户端配置片段与安全模型见
[`mcp/code-review-mcp/README.md`](mcp/code-review-mcp/README.md)，方案与验证记录见
`需求开发评审一致性平台/V1.47-远程MCP提交需求评审/`。

## 评审报告批量下载（V1.69）

批次的「评审列表」页可以勾选多条需求，一次导出评审报告，两种形态：

- **Excel 汇总**（一份 `.xlsx`，5 个 Sheet：批次信息 / 需求评审 / 验收点 / 风险 / 代码证据）——
  验收点、风险、证据都是一对多，各自一张明细表才筛得动（"把所有未实现的验收点列出来"）；
- **Markdown 逐条**（一个 `.zip`，每条需求一个 `.md` + 一份汇总）—— 直接发给负责那条需求的人。

三条边界：

- **按钮上写明范围。** 勾选了就是"已勾选 N 条"，没勾选就是"当前筛选 N 条"或"全部 N 条"，
  数字就是实际导出的条数。混用"全部"和"筛选结果"是最容易让人拿着不完整报告去开会的地方，
  所以筛选在页面侧算完（不依赖 antd 的回调时机），从看板下钻带 `?verdict=` 进来时也准。
- **不编没有的结论。** 没有 AI 结果写「未分析」，没有人工确认写「待确认」，批次还没导入过
  结果就把模型/基线写成「未导入」。历史格式的报告（没有逐项验收点）会明确标注是历史格式，
  不会被当成"这次分析没做验收点"。
- **报告带出处**：批次、发布周期、代码基线分支与基线 Commit、分析模型、分析完成时间、导出时间。
  一份不知道"是哪次分析、基于哪个 commit"的报告，过两周就没人敢用。

纯前端功能：数据来自页面已经加载的批次工作区（`getBatchWorkspace`），不新增接口、
不改数据库、不改 Worker；没有权限的人连列表都看不到，所以也没有新的读通道。

## 微信扫码登录与账号绑定

登录页支持微信开放平台网站应用扫码登录，邮箱老用户可在“个人中心”绑定微信并继续使用原账号。部署前需要应用 `0013_wechat_identity.sql`、配置微信服务端 Secrets，并以公开回调模式部署 Edge Function。

完整配置与安全说明见 [`supabase/functions/wechat-auth/README.md`](supabase/functions/wechat-auth/README.md)。
