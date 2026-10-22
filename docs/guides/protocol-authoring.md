# Writing a protocol

A protocol is a YAML file validated by `src/protocol/schema.ts`. Drop it in `.proofloop/protocols/` (project) and it appears in `proofloop protocols`. Check it with `proofloop protocol validate my.yaml` — errors carry file, line (YAML syntax) or schema path.

```yaml
schemaVersion: 1
id: my-feature              # kebab-case, unique (built-ins cannot be replaced)
version: 1.0.0
title: My feature protocol
description: …
engine: ">=0.7.0"          # minimum ProofLoop; newer-engine protocols are refused with a clear message
mode: existing-repo          # or idea-to-product
defaultRisk: medium          # low | medium | high | critical
retry: { maxRepairAttempts: 3, stopOnIdenticalFailure: true }
requiredArtifacts: [intent-brief, acceptance-criteria, implementation-plan, approved-plan-record]
gates:
  - { id: unit, kind: unit, required: true }
  - { id: browser, kind: browser, required: true, minRisk: medium }
phases:
  - { id: verification, title: Run gates, gates: [unit, browser] }   # verification and delivery are mandatory
  - { id: delivery, title: Open the pull request }
```

Rules the schema enforces: unique ids; every phase gate is declared; `verification` and `delivery` can never be skipped; skipped phases need a real reason; high/critical protocols need an unskipped `review`; `existing-repo` protocols need at least one required gate.

**Gate commands are never in the protocol.** They come from the plan the human approves (`gateCommands`), `.proofloop/config.json` (`commands.<gate-id|kind>`), or repository detection, in that order. A standard check (lint, typecheck, unit, build, integration, security-scan, browser, migration) that the repository cannot run is reported as a limitation below high risk and blocks at high risk. Kinds `custom`, `performance` and `load` have no default command and block until bound or built in.

**Required artifacts** are satisfied by plan content the engine already validated (intent, impact map, acceptance criteria, tasks, test plan, approval), by engine evidence (reproduction, baseline, before/after), or by `proofloop artifact add <run> <name> --file …`. Presence is checked; quality is the reviewer's job.

Built-in gate ids with in-process evaluators: `baseline-recorded`, `before-after`, `baseline-green`, `contract-drift`, `blueprint-valid`, `assumptions-visible`, `evidence-preserved`. The engine always adds `test-integrity`, `required-artifacts`, `migration-readiness`, and `ac-traceability` (medium risk and up).

Examples: `examples/protocols/` (Next.js, FastAPI, Node bugfix, generic).
