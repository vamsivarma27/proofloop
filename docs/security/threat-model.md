# Threat model and permission model

Scope: ProofLoop running locally on a developer machine, orchestrating Claude Code against a repository the developer owns. It is not a multi-tenant service.

## Assets
Source code and history; credentials in the environment and `~/.config` (gh, Claude, cloud CLIs); the state database (approvals, evidence); the developer's GitHub account.

## Trust boundaries and actors
| Actor | Trusted for | Not trusted for |
|---|---|---|
| Human developer | approving plans and gated actions | — |
| ProofLoop engine/CLI | state transitions, running approved gate commands | executing arbitrary text |
| Claude Code agent sessions | proposing plans, editing within scope | approving, marking verified, running gates, pushing |
| Repository files, issue/PR text, web pages, tool output | being read as data | giving instructions |

## Threats and controls
| Threat | Control | Tested in |
|---|---|---|
| Prompt injection via repo/issue/web content steers the agent | content fenced as data; capabilities limited outside the model (tool lists, hook, policy); agent cannot mutate approvals/state | `policy`, `cli` (hook), `composer` |
| Agent approves its own plan or marks gates passed | approvals require a `human:*` actor and a matching plan hash; `proofloop approve/run/gates/…` denied to agent sessions by hook and `--disallowedTools`; gate results are written only by the engine | `plan`, `cli`, `state` |
| Agent weakens or deletes tests to get green | `test-integrity` gate (convention + plan-declared test files, assertion token counts), needs a human-approved `test-change` | `repo`, `gates`, `engine` |
| Out-of-scope or protected-path edits (`.git`, `.env`, CI config, keys) | post-step scope enforcement reverts them; write denylist; PreToolUse hook denies | `engine`, `cli`, `policy` |
| Destructive/production command | shell operators rejected; destructive/critical/network patterns need approval scoped to the exact command; allowlist cannot launder them; production environment blocks gates without `production:<gate>` approval | `policy`, `gates`, `perf` |
| Secrets leak into logs, evidence or GitHub | redaction on every persisted string; scrubbed child environments; secret-shaped files unreadable; tests assert a canary secret never reaches artifacts | `gates`, `evals` |
| Malicious model-written program (Code Mode) | Node permission model (no write/spawn/net), empty env, validated tool calls, limits, write tools opt-in | `composer` |
| Stale or forged evidence | evidence stores commit + checksum; delivery recomputes checksums and rejects other commits; append-only triggers | `engine`, `gates` |
| Duplicate GitHub writes after retries | marker-based idempotency + outbox; outages are reported as queued, not synced | `github` |
| Hook crash/timeout lets a call through | `onFailure: block`; unreadable input exits 2 | `cli` |

## Residual risks (stated, not hidden)
- A user who runs Claude Code with permissions bypassed (`--dangerously-skip-permissions`) removes the interactive confirmation for approvals. The engine still requires a `human:*` actor, but the CLI cannot tell a human from a bypassed agent in that mode.
- The append-only ledger is enforced by SQLite triggers; anyone with write access to `.proofloop/state.db` can alter it. Do not treat it as tamper-proof.
- Gate commands run with your user's privileges in a worktree; a malicious repository's test script can still do harm. Only approve plans for repositories you trust.
- The test-integrity gate is heuristic. A reviewer and a human remain responsible for test quality.
- Claude Code itself is a dependency: this design relies on its documented flags and hook contract.

## Permission model
Claude Code permissions are never disabled. Engine-spawned sessions use `--permission-mode dontAsk --permission-prompts none` with an explicit tool allowlist per role (read-only for planner, reviewers and evaluators), plus a disallow list for approval/state commands. Interactive sessions keep their normal prompts; the hook adds a prompt for approve/reject and for critical shell commands.
