# Architecture overview

ProofLoop is a local-first engine. The Claude Code plugin is a thin surface over a CLI; the CLI drives an engine whose truth lives in SQLite and Git, with GitHub as the human-readable record.

## Layers

1. **Plugin surface** (`skills/`, `agents/`, `hooks/`, `bin/`): no state-machine logic in prompts. Skills run `proofloop …` and relay output. Commands that change state are `disable-model-invocation`, so only a user can trigger them.
2. **CLI** (`src/cli`): parses commands, refuses state-changing actions from agent sessions (`PROOFLOOP_AGENT_SESSION=1`), formats output.
3. **Engine** (`src/engine`): `Engine.drive(runId)` re-reads durable state each step and advances until a human is needed, the run is blocked/paused, or it ends. Because every step is derived from the database, a killed process resumes by calling `drive` again.
4. **State** (`src/state`): SQLite via `node:sqlite`. `Store.transition` is the only way to change state; guards run inside the transaction. `gate_result`, `evidence_artifact` and `event` have triggers that make them append-only at the application level (not tamper-proof against someone who owns the file).
5. **Adapters**: `GithubPort` (gh CLI), `AgentRuntime` (Claude Code `-p`), `ToolComposer` (sandbox), `QueryPlanAdapter` (SQLite), git worktrees. Each is replaceable and covered by a contract in `src/sdk/contracts.ts`.

## Task lifecycle

`NEW → DISCOVERING → PLANNING → AWAITING_APPROVAL → APPROVED → READY → RUNNING → VERIFYING → REVIEW_REQUIRED → PR_OPEN → COMPLETE`, plus `BLOCKED`, `PAUSED`, `CANCELLED` and `REPAIRING`. Guards worth knowing:

- `APPROVED/READY/RUNNING` require `approved_plan_hash == current_plan_hash`. Editing a plan changes the hash, so approval is lost.
- `REVIEW_REQUIRED`, `PR_OPEN`, `COMPLETE` require every required gate to be `PASS` **on the head commit**, and at least one required gate that is not an engine-added integrity gate.
- `REPAIRING` is refused when the repair budget is spent.
- `COMPLETE` is reachable only from `PR_OPEN`, and the engine only calls it when the PR is merged (or, in local-only mode, when the branch is merged).

## One run, step by step

1. `start`: idempotent run creation (hash of protocol + intent + repo), pinned protocol hash, parent GitHub issue (marker-deduplicated).
2. Planner (read-only role) produces a plan against a JSON schema. `validatePlan` enforces: acceptance criteria each map to a test or documented manual check; tasks cover every criterion; task DAG is acyclic; risk is not below the path-derived floor; bug plans carry reproduction, regression test and root cause. Invalid plans change nothing and are fed back (max 3 attempts).
3. A human approves a plan hash (`proofloop approve <id> --plan-hash <hash>`).
4. Worktree + branch are created; the gate plan is bound to **detected** commands (never invented). Standard checks the repository cannot run are listed as limitations below high risk and stay required (so they block) at high/critical risk.
5. Scheduler: tasks run in dependency order. Parallel only when file scopes provably do not overlap; otherwise sequential. Each task has a lease with generation fencing and heartbeats; tasks run in their own worktree and are merged into the integration branch, falling back to sequential on conflict. After each agent call the engine reverts edits outside the task scope or in protected paths.
6. Verify: commit pending changes, escalate risk from changed files (never lower), run gates on the exact commit, record evidence. Failures are classified (code defect, environment, infrastructure, rate limit, permission, flaky, unknown). Only code defects and unknowns trigger bounded repair; identical repeated failures stop early.
7. Review: fresh-context read-only reviewers (security reviewer too from high risk) see the diff and the recorded gate evidence. A review that cannot run blocks.
8. Delivery: evidence integrity is re-checked (files exist, checksums match, commit matches); the PR body is generated from the ledger only.

## Idea-to-Product

Same state machine. Discovery is interactive: the session asks the engine for the next interview question (topics already answered are never re-asked), researches with citations, and submits a blueprint JSON. The engine validates facts vs assumptions vs research (URL + consulted date), traces requirements to features, stack choices and milestones, checks the roadmap DAG, and surfaces every unconfirmed high-impact assumption. Only after a human approves the exact blueprint hash does the engine create GitHub issues (sub-issues and blocked-by links where the API supports them) and commit docs/ADRs.

## Code Mode (optional)

`ToolComposer` lets a model write one small program that calls typed tools. The local adapter runs it in a child with `node --permission` (no file writes, no child processes, no network), an empty environment, and a JSON-line bridge; the host validates every call, enforces call/time/output limits, and only exposes write tools if explicitly authorized. It refuses to run on Node versions that cannot deny network access. The core protocols never depend on it.

## Data model

See `src/state/db.ts`: `project`, `task_run`, `plan`, `step_run`, `task_node`, `approval`, `gate_plan`, `gate_result`, `evidence_artifact`, `worker_lease`, `event`, `idempotency`, `sync_outbox`. Timestamps are UTC with a `_utc` suffix. Runtime state can be reconciled with GitHub; GitHub is not used as a lock manager.
