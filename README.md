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
the frontend. It polls Supabase, prepares the four whitelisted repositories at a
frozen commit SHA, runs the two-stage `ReviewHarness` (retrieval → analysis) over
read-only code tools, validates structured results, and writes AI results via
service-role RPCs.

Scripts:

```bash
npm run worker:build   # tsc -p tsconfig.worker.json  -> dist-worker/
npm run worker:start   # node dist-worker/index.js
npm run worker:check-connectivity # GitLab + Supabase/Vault + minimal model ping
npm run worker:dev     # tsx worker/src/index.ts
npm run test:worker    # vitest run worker
```

Container deployment (default 4 replicas × 2 story slots = capacity 8):

```bash
docker compose -f docker-compose.worker.yml up -d --scale worker=4
```

See `worker/OPERATIONS.md` for the full Secret checklist, deployment,
connectivity verification, logging/audit rules, and the weekly runbook.
