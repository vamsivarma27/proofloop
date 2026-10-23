# Changelog


## 1.0.0-rc.5
- `proofloop test` is now the full project test (the `test` protocol): lint, typecheck, unit/regression suite, build, integration, Playwright browser journeys once per persona (ordinary, impatient, unauthorized, accessibility), security scan and migration on the current commit, compared gate by gate with the merge base in a detached worktree (regression / pre-existing / fixed). Writes `.proofloop/test-runs/<time>/report.{md,json}` plus gate logs and evidence; failures become bugs (optionally GitHub issues via `--file-bugs`); a missing check is a coverage gap, never a pass. `/proofloop:test` and a bare "test" prompt run it without asking which suites.
- The earlier scripted self-suites moved to `proofloop selftest`.

## 1.0.0-rc.4
- `/proofloop:test` and `proofloop test [suite...|all]`: end-to-end suites (feature, bug, integration, browser, performance, recovery, blocked) through the real engine; writes `.proofloop/test-runs/<time>/log.jsonl`, `report.md`, `report.json`; wrong outcomes, safety and evidence problems become bugs, optionally filed as GitHub issues with `--file-bugs owner/repo` (idempotent). Typing just "test" / "run all tests" / "test bug and recovery" starts it via a UserPromptSubmit hook.

## 1.0.0-rc.3
- Fix: the guard hook asked for approval on any command that merely mentioned `approve` near a path containing `proofloop` (e.g. a grep in the plugin cache). It now judges the command actually run.
- Plans open with an at-a-glance table and end with next steps; `/proofloop:approve` asks once.
- V0.2 engineering memory: `RETRIEVING_MEMORY` workflow state, append-only incident records (hypotheses vs evidence-confirmed root causes, preserved failed attempts), explainable historical retrieval over local incidents, GitHub issues/PRs and decision records with partial-failure reporting, and an exportable Proof Ledger (`proofloop ledger export`, JSON and Markdown) with revision-specific, stale-aware verification. See docs/guides/memory-and-ledger.md.
- Real-model eval keeps the directory of any failed run and names it in the report notes, so unexplained failures can be diagnosed.
- Claude Code marketplace manifest (`/plugin marketplace add vamsivarma27/proofloop`), scoped npm package `@vamsiivarmaa/proofloop` (publish tag `next`), new README with hero figure.
- Fix: `bin/proofloop` failed when npm linked it into `node_modules/.bin` (symlink not resolved); found by installing the packed tarball into a fresh project. Covered by a test.
- `SequentialToolComposer`: fallback that needs neither the Node 25 sandbox nor Cloudflare. The program is a JSON array of `{tool, args}` steps, never code; the shared `ToolHost` still enforces tool existence, write authorization, input schema, call and time limits.
## 1.0.0-rc.2
- Real-model evaluation mode (`proofloop eval --runtime claude`), first run published; it found two ProofLoop bugs (plan schema rejected by the CLI; regression-test command not derived from the approved plan), both fixed.
- Cloudflare bridge to a user-deployed Worker (own contract, double opt-in, local-mock-tested only) over a shared `ToolHost`.
- Second fresh-context security review: gate plan and evidence hashes are now signed, exclusive key creation, bridge refuses redirects and oversized responses, per-run call counters, byte-accurate truncation, cost-cap hardening.
- Apache-2.0.

## 1.0.0-rc.1 — feature/proofloop-v1

Built in one pass from `PROOFLOOP_PRD.md`; each section maps to a roadmap release.

### v0.1 core harness
- Task state machine with guards in SQLite; durable steps, idempotent run creation, append-only evidence.
- Feature and bug protocols, sequential execution in an isolated worktree, bounded repair, GitHub parent issue and checkpoints (idempotent, outage-safe).
- Plan artifact with acceptance criteria, impact map, DAG, test plan and engine-enforced minimum risk; human approval bound to the plan hash.
- Gate runner with PASS/FAIL/BLOCKED and commit-pinned, redacted, checksummed evidence; detected commands only.
- `status`, `resume` (reconciles with Git), `cancel`, `pause`, `report`, PreToolUse guard, plugin packaging.

### v0.2 Idea-to-Product
- Interview tracker, cited-research validation, facts/assumptions/recommendations separation, stack-vs-requirements checks, roadmap DAG, approval-gated issue creation, ADR/spec templates.

### v0.3 parallel and durable execution
- Leases with generation fencing, heartbeats, dead-worker reclaim, worktree-per-task, scope-overlap-aware batching, integration merge with sequential fallback, failure classifier, cancellation/pause.

### v0.4 evidence-driven QA
- App lifecycle, per-persona Playwright runs, trace hashing, acceptance-criteria traceability, environment failures are BLOCKED, test-weakening detection, fresh-context reviewers.

### v0.5 Code Mode
- Provider-neutral `ToolComposer`, typed tools, Node-permission sandbox (fails closed), disabled Cloudflare adapter, benchmark.

### v0.6 production readiness
- Performance evidence rules (baseline, workload, target, sample size, simulated vs live), SQLite query-plan inspection, required artifacts, migration readiness (rollback notes, destructive-SQL approval), production-environment guard, readiness report.

### v0.7 SDK
- Protocol validation with line/path diagnostics, example protocols, adapter contract kit, pinned protocol/plugin versions in evidence.

### Evaluation
- 22-task scripted suite with hidden acceptance checks and a no-harness baseline. The first run found and fixed two harness defects (see git history: test-integrity missed plan-declared test files; directory evidence broke integrity checking).

### Security review
- Fresh-context review found 10 issues (1 critical); fixes and residual risks in docs/security/threat-model.md.

### Known limitations
- Cloudflare Code Mode adapter not implemented. No real-model evaluation published. Windows unsupported. 
