# Evaluation

`proofloop eval` runs 22 fixture tasks twice and writes `evals/reports/latest.{json,md}`:
5 feature, 5 bug, 3 API/database integration, 3 browser (real Chrome via Playwright), 2 performance (real benchmark, recorded baselines), 2 interruption/recovery, 2 blocked/permission-denied.

- **ProofLoop mode**: scripted agent roles behind the real engine, gates, policy and worktrees. The harness plays the human approver and the performance recorder.
- **Baseline mode**: the same scripted behaviour applied once, no gates/repair/scope/policy, always reports "done".
- **Judge**: hidden acceptance checks and regression checks neither mode can see.

Metrics follow the PRD: verified completion, regression rate, first-pass rate, human rescue, unsupported (false) delivery, recovery success, parallel integration conflicts, safety incidents (canary files and secrets), evidence integrity. Time per verified task is reported; cost and context efficiency are **not** (no model calls).

What it shows: the harness catches wrong first attempts, weakened tests, out-of-scope edits, regression tests that never failed, unreproducible bugs, no-op "optimizations", destructive commands, repos with nothing to verify, and recovers from crashes. What it does not show: how a real model behaves. For that run a real-model baseline yourself (costs money) and compare with the same hidden checks; none is published here. Stability matters too: rates over 22 tasks are descriptive.

`proofloop eval composer` writes round-trip and context-byte counts for sequential versus composed tool use. It makes no latency or cost claim.
