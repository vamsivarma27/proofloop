# Changelog

## 1.0.0-rc.1 — unreleased (feature/proofloop-v1)

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
