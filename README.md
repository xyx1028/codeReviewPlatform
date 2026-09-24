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
  2055/90 端口 —— 默认只有 `80,443` 时表现为 `CONNECT tunnel failed, 403`。
- **能力契约没动**：附件走 workspace 文件而不是新工具，manifest revision 仍是 3，新旧 Worker 可混跑。

运维面（env 清单、代理端口、导入队列 SQL、错误码表、孤儿附件回收、回滚、复跑验证命令）见
`worker/OPERATIONS.md` 第 21 节。

## 微信扫码登录与账号绑定

登录页支持微信开放平台网站应用扫码登录，邮箱老用户可在“个人中心”绑定微信并继续使用原账号。部署前需要应用 `0013_wechat_identity.sql`、配置微信服务端 Secrets，并以公开回调模式部署 Edge Function。

完整配置与安全说明见 [`supabase/functions/wechat-auth/README.md`](supabase/functions/wechat-auth/README.md)。
