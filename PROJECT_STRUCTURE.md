# Project structure

```
.claude-plugin/plugin.json   plugin manifest (name proofloop, namespaced commands /proofloop:*)
skills/<name>/SKILL.md       thin slash commands that call bin/proofloop
agents/*.md                  role definitions (read-only unless implementer/test-designer)
hooks/hooks.json             PreToolUse guard (fails closed)
bin/proofloop                launcher for dist/cli.js
dist/cli.js                  bundled CLI (committed; CI checks it is in sync)
protocols/*.yaml             built-in protocols; examples/protocols/ shows custom ones
templates/                   ADR, plan, product spec, repository contract, blueprint example
src/
  state/      SQLite schema, transition table + guards, store
  policy/     command allowlist/denylist, path containment, risk floor, untrusted fencing
  gates/      plan, runner, built-in gates (integrity, drift, artifacts, migration, perf)
  engine/     drive loop, steps, scheduler, classifier, prompts, report, factory
  github/     gh adapter + durable sync (outbox)
  agent/      Claude Code runtime (documented `claude -p` flags only) + scripted runtime
  composer/   ToolComposer: typed tools, Node-permission sandbox, disabled Cloudflare adapter
  browser/    app lifecycle, Playwright result mapping, AC traceability
  perf/       measurements/verdicts, query plans, recording
  blueprint/  Idea-to-Product schema, interview, rendering, roadmap publishing
  evals/      scripted evaluation suite + composer benchmark
  sdk/        adapter contract kit
  cli/        argument handling, hook guard
tests/        vitest suites (unit, contract, end-to-end with real git)
evals/reports/  latest generated evaluation reports
docs/         architecture, decisions (ADRs), guides, security, plans
```

Naming: top-level documents are `CAPITAL_CASE.md`; folders under `docs/` are `kebab-case`. Database tables are singular snake_case with `_utc` timestamps. ProofLoop is a local single-user tool with no network service, so multi-tenant rules (`tenant_id`) do not apply.
