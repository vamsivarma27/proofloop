# ProofLoop

A protocol-driven, evidence-based engineering harness for [Claude Code](https://code.claude.com). It does not write code itself. It is the system around the coding agent that makes good engineering behaviour repeatable and checkable:

> Describe the outcome. ProofLoop discovers what matters, asks only necessary questions, prepares a plan for approval, executes within the approved scope, verifies the running software, and reports what is proven, what is not, and what remains blocked.

**ProofLoop does not promise bug-free software or unlimited capacity.** It lowers risk, catches defects earlier, makes risk visible, and refuses to present unverified work as complete.

Status: **1.0.0-rc.1, private pre-release.** License is undecided (`UNLICENSED` for now; Apache-2.0 is the recommendation in the PRD). Platforms: macOS and Linux. Windows is not validated.

## How it works

```
 you ── /proofloop:feature "…" ──► skills (thin)  ──► proofloop CLI ──► engine
                                                                          │
   GitHub issues/PRs  ◄── GithubPort (gh CLI) ◄──────────────────────────┤  durable record
   SQLite (.proofloop/state.db) ◄── state machine + guards ◄─────────────┤  runtime truth
   Claude Code (claude -p) ◄── AgentRuntime (planner/implementer/reviewers)┤  roles, least privilege
   git worktrees ◄── scheduler (leases, scopes, integration) ◄───────────┤  isolation
   gates: lint/type/test/build/browser/perf/security ──► evidence ledger ─┘  PASS | FAIL | BLOCKED
```

The things that matter are **code, not prompts**:

| Rule | Where it is enforced |
|---|---|
| No implementation before a human approves the exact plan hash | state-machine guard (`src/state/machine.ts`) |
| Agents cannot approve, change state, or mark anything verified | `human:` actor check in the store, PreToolUse hook, role tool lists |
| A required gate is `PASS`, `FAIL` or `BLOCKED`; skipped/unavailable is never a pass | gate runner + guard on `REVIEW_REQUIRED` / `PR_OPEN` / `COMPLETE` |
| Evidence names the exact commit and is checksummed | evidence ledger (append-only triggers) |
| Tests cannot be weakened to get green | `test-integrity` gate |
| Destructive/production commands never run without scoped approval | command policy |
| Repo files, issues, web pages are untrusted data | fencing + capabilities enforced outside the model |
| Interrupted runs reconcile with Git instead of restarting | `resume` |

## Install (from this repo)

```bash
pnpm install && pnpm build
claude --plugin-dir /path/to/proofloop        # try it in a session
claude plugin validate /path/to/proofloop      # optional
```

Requirements: Node ≥ 22.13 (≥ 25 to use the optional sandboxed Code Mode), Git, Claude Code ≥ 2.1.259, optionally `gh` (authenticated) for GitHub issues and PRs. The CLI is also usable directly: `bin/proofloop`.

## First run

```text
/proofloop:setup                         # read-only self-check; asks before writing .proofloop/config.json
/proofloop:feature Add pagination to the users page
   → plan with acceptance criteria, impact map, risk and a gate preview
/proofloop:approve <run-id>              # you review the plan hash; the permission prompt is the confirmation
proofloop run <run-id>                   # implement in a worktree, verify, review, open a PR
/proofloop:status
```

Without GitHub the run ends with a local branch and a clear note; it is never presented as equivalent to a PR.

## Commands

| Command | Purpose |
|---|---|
| `/proofloop:setup`, `:protocols`, `:status` | environment, protocols, active runs/gates/blockers |
| `/proofloop:feature`, `:bug`, `:diagnose`, `:performance` | task protocols (`refactor`, `security` via CLI) |
| `/proofloop:start-project` | Idea-to-Product: interview, cited research, blueprint, roadmap issues |
| `/proofloop:approve`, `:resume`, `:cancel`, `:verify` | lifecycle and basic verification |
| `proofloop eval`, `eval composer` | scripted evaluation suite and Code Mode benchmark |

## What is verified, and what is not

- Verified by tests in this repo: state machine and guards, policy, gates and evidence, GitHub adapter contract (mocked `gh`), parallel scheduling/integration, interruption recovery, bug/performance/migration/browser rules, blueprint validation, sandbox isolation, the PreToolUse hook.
- Browser evidence is exercised against a real Chrome through Playwright in the eval suite.
- The evaluation suite uses a **scripted agent**, so it measures the harness, not model quality. No real-model baseline comparison is published. See [docs/guides/evals.md](docs/guides/evals.md).
- The **Cloudflare Code Mode adapter is not implemented** (upstream is experimental). It is present as a disabled, fail-closed adapter.
- `gh` flows are tested against a faithful fake and were also exercised live against this repository: idempotent issue creation (re-running created no duplicates), search-based dedupe, sub-issue linking, a checkpoint comment and the pull request. Blocked-by links, PR status polling and push flows are covered by the fake only.

## Documentation

[Architecture](docs/architecture/overview.md) · [Threat model & permissions](docs/security/threat-model.md) · [Protocol authoring](docs/guides/protocol-authoring.md) · [Adapters & contracts](docs/guides/adapters.md) · [Troubleshooting & recovery](docs/guides/troubleshooting.md) · [Compatibility](docs/guides/compatibility.md) · [Evaluation](docs/guides/evals.md) · [Decisions](docs/decisions/) · [Release status](docs/plans/release-status.md) · [Getting started](GETTING_STARTED.md)
