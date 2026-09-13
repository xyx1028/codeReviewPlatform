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

## 微信扫码登录与账号绑定

登录页支持微信开放平台网站应用扫码登录，邮箱老用户可在“个人中心”绑定微信并继续使用原账号。部署前需要应用 `0013_wechat_identity.sql`、配置微信服务端 Secrets，并以公开回调模式部署 Edge Function。

完整配置与安全说明见 [`supabase/functions/wechat-auth/README.md`](supabase/functions/wechat-auth/README.md)。
