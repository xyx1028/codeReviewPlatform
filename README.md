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

## 微信扫码登录与账号绑定

登录页支持微信开放平台网站应用扫码登录，邮箱老用户可在“个人中心”绑定微信并继续使用原账号。部署前需要应用 `0013_wechat_identity.sql`、配置微信服务端 Secrets，并以公开回调模式部署 Edge Function。

完整配置与安全说明见 [`supabase/functions/wechat-auth/README.md`](supabase/functions/wechat-auth/README.md)。
