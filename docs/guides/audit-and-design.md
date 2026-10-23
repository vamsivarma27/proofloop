# Audit and system design

`proofloop audit [--users 2000] [--p95 300] [--p99 800] [--error-rate 0.01] [--path /api/x ...]` (or `/proofloop:audit`, or just type `audit for 5000 users, p99 under 500ms`).

| Part | Kind | What it gives |
|---|---|---|
| Capacity model | assumption | users -> concurrent users, average and peak rps, in-flight requests (Little's law). Assumptions are printed. |
| Probe | measured | Starts the app (`app.start` + `app.url` in `.proofloop/config.json`), sends requests to each `--path` with bounded concurrency, reports p50/p95/p99, errors and rps against your targets. |
| Load test | measured | Runs `commands.load` (or a `test:load` / `load` / `bench` script) as a gate; FAIL is a violation. |
| Static scan | heuristic | Unbounded queries, N+1, outbound calls without timeouts, sync I/O, process-local state, retries without backoff, with `file:line`. |
| Design review | reviewed | Eight checklist areas (capacity, data-access, caching, concurrency, resilience, scalability, failure-modes, observability) answered by the reviewer with evidence. `proofloop audit --checklist` prints them. |

Status is `measured-ok`, `violations`, `needs-review` or `not-measured`. It is never ok unless something was measured and met its targets, and the probe is one machine: it does not prove N users.

## Building with scale in mind

Plans may carry a `design` section: `scale` (expected users, p95/p99/error-rate targets) and `decisions` per checklist area. If a scale is stated, validation requires a load or performance check in the test plan. The planner is given the checklist and told to state scale and targets, the implementer is told to honour the decisions (bounded queries, pagination, timeouts, idempotency), and the reviewer checks the diff against them. A medium-or-higher-risk plan with no design section gets a warning.
