# Release status against the PRD

Legend: ✅ implemented and tested here · ⚠ implemented with a stated limit · ⏳ needs an action outside this repository.

## v0.1 core harness
| AC | Status | Evidence |
|---|---|---|
| 1 One parent issue, no duplicates on retry | ✅ | `tests/github.test.ts` (marker + local key + lost-state), `tests/engine2.test.ts` |
| 2 No implementation before approval | ✅ | guards in `tests/state.test.ts`; `tests/engine.test.ts` first scenario |
| 3 Plan has intent, assumptions, modules, criteria, tests, risk | ✅ | `tests/plan.test.ts` |
| 4 Undetected commands are reported, not invented | ✅ | `tests/repo.test.ts`, `tests/engine.test.ts`, ADR 0006 |
| 5 PASS/FAIL/BLOCKED with evidence refs | ✅ | `tests/gates.test.ts` |
| 6 Interrupted run reconciles | ✅ | `tests/engine2.test.ts` (crash, dead-worker lease, moved HEAD, missing worktree) |
| 7 Test failure cannot reach COMPLETE | ✅ | `tests/state.test.ts`, `tests/engine.test.ts` |
| 8 No permission controls disabled | ✅ | `tests/agent.test.ts` |
| 9 State-machine tests | ✅ | `tests/state.test.ts` |

## v0.2 Idea-to-Product
All seven criteria ✅ in `tests/blueprint.test.ts`. ⚠ Research itself is performed by the Claude session with WebSearch/WebFetch; the engine validates structure, citations and dates, not whether a source supports a claim. ⚠ GitHub behaviour is verified through mocks plus live use on this repository (issue creation, dedupe, sub-issues, checkpoint, PR). Blocked-by links and PR status polling were not exercised live.

## v0.3 durable and parallel
| AC | Status | Evidence |
|---|---|---|
| 1 Two independent tasks run concurrently in separate directories | ✅ | `tests/engine2.test.ts` |
| 2 Dependent task waits | ✅ | same |
| 3 Expired leases recovered without duplicate ownership | ✅ | `tests/state.test.ts`, recovery test (dead pid) |
| 4 Cancellation preserves branch/state | ✅ | `tests/engine2.test.ts` (cancellation) |
| 5 Identical failures stop early | ✅ | `tests/engine.test.ts` |
| 6 Integration gates run after merge | ✅ | parallel test verifies gates on the integration head |
| 7 Runtime state reconciled with Git | ✅ | resume tests |
⚠ Merge-conflict fallback is implemented (`integrate`) but exercised only through Git-level tests; no end-to-end conflict scenario is constructed because scope enforcement prevents overlapping edits in the first place.

## v0.4 evidence-driven QA
All seven ✅ (`tests/browser.test.ts`, `tests/engine.test.ts`, evals browser tasks run real Chrome). ⚠ Personas are executed by re-running the repository's browser command with `PROOFLOOP_PERSONA`; the repository's tests decide what a persona means.

## v0.5 Code Mode
| AC | Status |
|---|---|
| 1–4 composition, limits, denial tests, core works without it | ✅ `tests/composer.test.ts` (sandbox tests run on Node ≥ 25; elsewhere the composer is verified to refuse) |
| 5–6 measured comparison | ✅ `proofloop eval composer` (round trips and context bytes only; no latency/cost claim) |
| Cloudflare adapter | ⚠ present but disabled; **not implemented**: Cloudflare documents no callable API for Code Mode and marks it experimental |

## v0.6 production readiness
All five ✅ in `tests/perf.test.ts` and `tests/gates.test.ts`. ⚠ Query-plan inspection ships for SQLite only; other databases need an adapter. ⚠ Load testing is a gate command (e.g. k6) plus a k6-summary importer; no load generator is bundled.

## v0.7 SDK
All four ✅ in `tests/sdk.test.ts`. ⚠ Contract kit is source-level (copy from `src/sdk/contracts.ts`); it is not published as an npm package.

## v1.0 release criteria
| Criterion | Status |
|---|---|
| Feature, bug and Idea-to-Product flows work end to end | ✅ |
| State, recovery, GitHub sync tested | ✅ (GitHub via faithful fake + live use on this repo) |
| Gates cannot be silently skipped | ✅ |
| Permissions, redaction, sandbox and threat model documented | ⚠ reviewed by a fresh-context AI reviewer (10 findings, fixed or documented); no human or third-party review |
| CI passes on the OS/Node matrix | ✅ all jobs green on PR #9, including after the security-review fixes |
| Evaluation reports baseline vs ProofLoop | ⚠ scripted agent only. A real-model mode exists (`proofloop eval --runtime claude`, capped spend) but has not been run; no real-model result is published |
| No known critical security defects | ⚠ the one critical finding (ledger forgery) is mitigated, not eliminated: same-user code can still read the key. No penetration test |
| Install/upgrade/uninstall/recovery/troubleshooting docs | ✅ README, compatibility, troubleshooting |
| Release artifacts, changelog, compatibility policy | ⚠ changelog, policy and release workflow exist; `v1.0.0-rc.1` is tagged on `develop`; no `v1.0.0` (the criteria below are unmet) |
| Known limitations explicit | ✅ |

The version is `1.0.0-rc.1` (PR #9 merged, Apache-2.0). Remaining before 1.0.0: a human or third-party security review, a real-model evaluation result, and the Cloudflare adapter if wanted.
