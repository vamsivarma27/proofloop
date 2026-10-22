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
| Repository content sent to a third party (Cloudflare bridge) | off by default; needs `PROOFLOOP_CODEMODE_CLOUDFLARE=1` and an explicit data-flow acknowledgement; https/token required for remote Workers; results are bounded and redacted before sending | `cloudflare` |
| Malicious model-written program (Code Mode) | Node permission model (no write/spawn/net), empty env, validated tool calls, limits, write tools opt-in | `composer` |
| Stale or forged evidence | evidence stores commit + checksum; delivery recomputes checksums and rejects other commits; append-only triggers | `engine`, `gates` |
| Duplicate GitHub writes after retries | marker-based idempotency + outbox; outages are reported as queued, not synced | `github` |
| Hook crash/timeout lets a call through | `onFailure: block`; unreadable input exits 2 | `cli` |

## Independent review (fresh-context reviewer, 2026-10-22)
A reviewer with no access to this conversation read the sensitive modules and reported 10 findings. Fixed in code, each with a test in `tests/hardening.test.ts`:
- **Ledger forgery (critical):** gate results and approvals are now HMAC-signed with a key outside any repository (`~/.proofloop/ledger.key`, mode 600). Unsigned or altered rows are ignored by the guards, plan approval is derived from signed rows (not the editable column), and delivery reports forged rows. Gate commands are allowed to the agent as exact commands only (no `*`), and the agent is denied `sqlite3`, `.proofloop/**` and the key.
- **Hook bypasses:** compound commands and reordered flags (`ls; terraform apply`, `rm -r -f`, `git -C . push --force`) are judged per segment; agent access to the state database, key or CLI internals is denied.
- **Test harness weakening:** changes to runner config and `scripts.test|lint|build|…`, plus more skip markers, need an approved `test-change`.
- **Evidence vs what is pushed:** a gate that changes HEAD or tracked files is BLOCKED; delivery refuses a branch tip that is not the verified commit.
- **Scope/paths:** rename sources are checked; deny lists are case-insensitive and cover `.npmrc`, `.netrc`, `.envrc`, kube/docker config.
- **Redaction:** titles are redacted; added database URLs, provider keys, JWTs, npm tokens; browser traces are labelled `binary-unredacted` instead of falsely `redacted`.
- **Sandbox:** call limit counts at receipt (bursts), garbage output and EPIPE cannot crash the host.
- **GitHub markers:** only the authenticated user's issues/comments count for dedupe, so a third party cannot suppress checkpoints.

Not fixed, by design or by limit: see the next section.

## Residual risks (stated, not hidden)
- **Same-user code execution.** A script the agent writes and a gate then runs executes with your privileges. The ledger key and signatures make forgery require reading the key (blocked for agent tools, not for arbitrary code), so this raises the bar; real isolation needs an OS sandbox or container for gate commands, which is not implemented.
- Gated approvals (`test-change`, `behavior-change`, `destructive-migration`) are bound to a run, not to a commit or a specific finding; one grant covers later commits of the same run.
- Gitignored build outputs present in the worktree are not part of the commit, so a test can pass against files the PR does not contain.
- Assertion-count checks can be defeated by rewriting assertions to equally many trivial ones (`expect(1).toBe(1)`); the reviewer and a human remain responsible.
- Whether Claude Code regex-matches hook matchers such as `MultiEdit` against `Edit` is not verified; the hook lists tools explicitly.
- A user who runs Claude Code with permissions bypassed (`--dangerously-skip-permissions`) removes the interactive confirmation for approvals. The engine still requires a `human:*` actor, but the CLI cannot tell a human from a bypassed agent in that mode.
- The append-only ledger is enforced by SQLite triggers; anyone with write access to `.proofloop/state.db` can alter it. Do not treat it as tamper-proof.
- Gate commands run with your user's privileges in a worktree; a malicious repository's test script can still do harm. Only approve plans for repositories you trust.
- The test-integrity gate is heuristic. A reviewer and a human remain responsible for test quality.
- Claude Code itself is a dependency: this design relies on its documented flags and hook contract.

## Permission model
Claude Code permissions are never disabled. Engine-spawned sessions use `--permission-mode dontAsk --permission-prompts none` with an explicit tool allowlist per role (read-only for planner, reviewers and evaluators), plus a disallow list for approval/state commands. Interactive sessions keep their normal prompts; the hook adds a prompt for approve/reject and for critical shell commands.
