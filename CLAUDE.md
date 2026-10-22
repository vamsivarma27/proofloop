# ProofLoop — contributor rules for Claude Code

Single TypeScript package (`src/`), bundled to `dist/cli.js`. Node ≥ 22.13, pnpm. This file guides work **on** ProofLoop; consumers of the plugin do not load it.

## Map
- `src/state/` SQLite store, transition table, guards. The only way a run changes state is `Store.transition`.
- `src/policy/` command, path, risk, untrusted-content rules. Deterministic; no model involved.
- `src/gates/` gate plan, runner (PASS/FAIL/BLOCKED + evidence), built-in evaluators.
- `src/engine/` drive loop (`engine.ts`), steps, scheduler (leases, worktrees, integration), prompts, report.
- `src/github/`, `src/agent/`, `src/composer/`, `src/perf/`, `src/browser/`, `src/blueprint/`, `src/evals/`, `src/sdk/` adapters and feature modules.
- `protocols/*.yaml` built-in protocols (schema in `src/protocol/schema.ts`). `skills/`, `agents/`, `hooks/`, `bin/` are the plugin surface and stay thin.

## Invariants (a change that breaks one is wrong)
1. Nothing marks work verified except gate results on the current head commit. A missing, blocked or stale required gate is not a pass.
2. Approvals are recorded only for `human:*` actors and bind to a plan hash. Agents get no ProofLoop-mutating tools.
3. Evidence is append-only and names the commit; artifacts are redacted before persistence.
4. New external capability goes behind a port/adapter with a contract test in `src/sdk/contracts.ts`.
5. Fail closed: unavailable sandbox, unparsable hook input, unknown protocol → refuse, never run unprotected.
6. Do not claim what is not measured (performance, scale, market validation, model quality).

## Commands
`pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm test:cov` (≥ 80 % lines, blocking) · `pnpm build` (commit `dist/`) · `./bin/proofloop eval` (scripted evals).
Tests that spawn `npm`/Chrome are slow under load; timeouts are generous on purpose.

## Workflow
Branches `feature/*`, `bugfix/*`, `task/*`; Conventional Commits; never `--no-verify` (the pre-commit hook runs gitleaks, typecheck, lint; enable with `git config core.hooksPath .githooks`). Test fixtures that look like credentials must be built at runtime (`tests/fake-secrets.ts`). No self-merge.
