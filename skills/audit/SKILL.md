---
name: audit
description: When the user says "audit" (optionally with a user count and p95/p99 targets, e.g. "audit for 5000 users, p99 under 500ms"), audit the project for scale and system design - measured latency percentiles under load, static scalability findings, and a checklist-driven design review.
argument-hint: "[--users 2000] [--p95 300] [--p99 800] [--error-rate 0.01] [--path /api/x]"
allowed-tools: Bash(proofloop *)
---

Do not ask first; run the audit. Defaults if the user gave no numbers: 2000 users, p95 300 ms, p99 800 ms, errors 1% - say you used defaults.

1. Run in the foreground with the Bash timeout at 600000 ms:

```
proofloop audit $ARGUMENTS
```

It sizes the load (users -> concurrent users, rps, in-flight requests, with printed assumptions), scans for scalability smells (unbounded queries, N+1, no timeouts, sync I/O, process-local state, retries without backoff), runs the repository's load test if there is one, and starts the app (`app.start` / `app.url` in `.proofloop/config.json`) to probe each `--path` for p50/p95/p99 and error rate.

2. Report the status exactly: `measured-ok`, `violations`, `needs-review` or `not-measured`. **Never say the app "can handle N users".** The probe is one machine; say what it measured against which targets. If nothing was measured (no app start command, no load test), say so and offer to add a k6 script or the app start config through `/proofloop:feature`.
3. Then do the design review yourself, read-only: run `proofloop audit --checklist`, read the code, and answer each area (capacity, data-access, caching, concurrency, resilience, scalability, failure-modes, observability) with `file:line` evidence, or say "no evidence found". Mark each answer reviewed, not measured. Check the static findings against the code and say which are real.
4. Offer fixes as a normal change (`/proofloop:feature` or `/proofloop:performance`) so they get a plan with design decisions, an approved plan hash, and a load check. Do not change code during an audit.
