# `code-review-acp` profile template

Source of truth for the DeepSeek Harness profile that runs one code-review
attempt. The worker never boots this directory in place: for every attempt it
materializes a private copy under that attempt's `DSH_HOME`, links the
platform's plugin packages into it, and boots

```text
dsh --profile code-review-acp --patch <attempt-route.patch.yml>
```

## Layers

1. `@deepseek-ai/dsh-base` — the shared core (llm, session, agent, tools,
   agent-loop, token meter, compaction).
2. `@deepseek-ai/dsh-acp-app` — the automation-only ACP surface; stdout belongs
   to the ACP stream.
3. `cordis.patch.yml` (this directory) — the allowlist: everything the attempt
   does not need is disabled by id, and the platform's three plugins are
   inserted.
4. `--patch <attempt-route.patch.yml>` — generated per attempt, in that
   attempt's `DSH_HOME` only. It carries the model route, budgets, broker
   socket path and claim token.

## Why these values are not in this directory

The attempt overlay holds the model route and the broker claim token. Keeping
them out of the profile directory means the checked-in template contains no
secret, and two concurrent attempts cannot read each other's route or token.
The API key itself is never written to any file: the route references an
environment variable name, and the worker passes that variable only to the
attempt's own child process.

## Adding a capability

Enabling anything here is a security change: state which snapshot or network
boundary it crosses, and add a matching allowlist test. The worker verifies the
resolved tool surface at boot, so a capability that appears without an
allowlist entry fails the attempt instead of reaching the model.
