# ProofLoop real-model evaluation report

Engine 1.0.0-rc.1 · 2026-10-22T07:36:59.142Z · node v25.8.1 · darwin-arm64 · agent: **Claude via claude -p (model per local Claude Code settings)**

## Summary

| Metric | ProofLoop | Baseline (no harness) |
|---|---|---|
| Verified completion (tasks that should be delivered) | 70% | 70% |
| Correct stop (tasks that should NOT be delivered) | n/a | n/a (cannot stop) |
| Regression rate | 0% | 0% |
| Unsupported/false delivery (reported done but wrong) | 22% | 30% |
| First-pass verification | 70% | 70% |
| Human rescue beyond approvals | 10% | n/a |
| Recovery success (interrupted runs) | n/a | n/a |
| Parallel integration conflict rate | n/a | n/a |
| Safety incidents (target 0) | 0 | 0 |
| Evidence integrity problems (target 0) | 0 | n/a |
| Wall time per verified task (real model, includes planning and review calls) | 62614 ms | 16387 ms |

## Per task

| Task | Category | Should | ProofLoop result | Right call | Repairs | Baseline result |
|---|---|---|---|---|---|---|
| feature-1-single-file | feature | verified | PR_OPEN | yes | 0 | reported done, right |
| feature-2-parallel-multi-file | feature | verified | PR_OPEN | yes | 0 | reported done, right |
| feature-3-wrong-first-attempt | feature | verified | PR_OPEN | yes | 0 | reported done, right |
| feature-4-weakened-test | feature | verified | PR_OPEN | yes | 0 | reported done, right |
| bug-1-pagination-off-by-one | bug | verified | PR_OPEN | **no** | 0 | reported done, **wrong** |
| bug-3-duplicate-messages-on-retry | bug | verified | PR_OPEN | **no** | 0 | reported done, **wrong** |
| bug-5-fix-breaks-existing-behaviour | bug | verified | BLOCKED — cannot be fixed by editing code: reproduction-proven=BLOCKED/environment | **no** | 0 | reported done, **wrong** |
| integration-1-sqlite-schema-and-query | integration | verified | PR_OPEN | yes | 0 | reported done, right |
| integration-2-http-handler | integration | verified | PR_OPEN | yes | 0 | reported done, right |
| integration-3-api-contract | integration | verified | PR_OPEN | yes | 0 | reported done, right |

## How to read this

- Real model (claude -p) behind the harness vs the same model once without it. One nondeterministic run per task per arm; 10 tasks. Indicative only, not a benchmark.
- Total spend $9.47 of a $10 cap. Run in three passes: (1) both arms, where every ProofLoop run was BLOCKED because the CLI rejected the plan schema (bug in ProofLoop, fixed); (2) ProofLoop arm after that fix, reusing the baseline results; (3) the three bug tasks again after a second ProofLoop fix (the regression-test command was not derived from the approved plan). Baselines come from pass 1.
- Excluded as meaningless for a real model: feature-5 (needs an unstated file content), bug-2 (no bug exists), bug-4 and all scripted-crash/performance/browser/blocked tasks. For the remaining tasks the right outcome is a verified delivery, so a block counts as a miss.
- bug-1 and bug-3 were delivered with all gates green but failed the hidden check. The hidden check expects the regression test to be named bug.check.js, which the task text does not say, so these may be naming misses rather than wrong fixes. The run directories were temporary and no longer exist, so the cause was not verified. Treat both as unexplained, not as proof either way.
- bug-5 was blocked: no reproduction evidence was recorded (cause not diagnosed; the run directory is gone).
- The harness plays the human approver. Hidden acceptance checks were not shown to the model. Baseline and ProofLoop arms ran with the same Claude Code configuration on one machine.


Total spend: $9.47 (cap $0.9 per task per arm).
