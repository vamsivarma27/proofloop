# Adapters and contract tests

| Port | Interface | Built in | Contract |
|---|---|---|---|
| GitHub | `GithubPort` (`src/github/adapter.ts`) | `GhAdapter` (gh CLI) | `githubPortContract` |
| Agent runtime | `AgentRuntime` (`src/agent/runtime.ts`) | `ClaudeCodeRuntime`, `ScriptedRuntime` | `agentRuntimeContract` |
| Tool composition | `ToolComposer` (`src/composer/types.ts`) | `LocalToolComposer`, disabled `CloudflareToolComposer` | `toolComposerContract` |
| Query plans | `QueryPlanAdapter` (`src/perf/queryplan.ts`) | `SqliteQueryPlanAdapter` | `queryPlanContract` |

Write a contract test in your adapter's repo:

```ts
import { githubPortContract } from 'proofloop/src/sdk/contracts';   // copy or vendor from src/sdk/contracts.ts
await githubPortContract(() => new MyPort(), { ok: (v, m) => expect(Boolean(v), m).toBe(true), equal: (a, b, m) => expect(a, m).toEqual(b) });
```

Behavioural requirements worth restating: ports are idempotent per key; unsupported optional capabilities return `'unsupported'` rather than throwing; failures are values (`ok:false`) not exceptions where the contract says so; nothing persisted may contain unredacted secrets; an unavailable composer must refuse to run.

The runtime adapter may only use **documented** Claude Code interfaces (`claude -p`, `--output-format json`, `--json-schema`, `--resume`, `--allowedTools`, `--disallowedTools`, `--permission-mode`, `--permission-prompts`, `--max-budget-usd`, `--settings`). `checkVersion()` requires ≥ 2.1.259.
