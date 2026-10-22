# 0001. SQLite via node:sqlite for runtime state

Status: accepted

## Context
The PRD asks for a local transactional store (leases, retries, approvals, evidence). Options: better-sqlite3 (native build per platform/Node), node:sqlite (built in since Node 22.5, still flagged experimental).

## Decision
Use node:sqlite with WAL, foreign keys, BEGIN IMMEDIATE transactions and PRAGMA user_version migrations. Require Node >= 22.13. Silence the ExperimentalWarning in the launcher only.

## Consequences
No native dependency to compile or ship, and one fewer thing to pin. We inherit node:sqlite API risk; the store is a single module (src/state) so swapping is contained.
