# Engineering memory and the Proof Ledger (V0.2)

ProofLoop keeps what it learns across tasks and can export one document that explains a run from intent to evidence. GitHub stays the source of truth for issues and pull requests; the local SQLite state (`.proofloop/state.db`) holds the structured records and the execution state needed to resume.

## Workflow

`NEW → DISCOVERING → RETRIEVING_MEMORY → PLANNING → AWAITING_APPROVAL → …`

`RETRIEVING_MEMORY` loads history, stores the result, and hands it to the planner. `DISCOVERING → PLANNING` is still a valid transition so runs created before V0.2 and the blueprint flow are unaffected.

## Incident records

Created automatically for `bug` and `diagnose` runs and linked to the run's GitHub issue. An incident is an immutable header plus **append-only entries** (database triggers refuse updates and deletes). Reading folds the entries into one record:

- symptoms, expected/actual behaviour, reproduction steps, environment
- root-cause **hypotheses** (start `UNVERIFIED`) and a **confirmed** root cause, which needs recorded evidence or a `human:*` actor — an agent's assertion is refused (`PL_INCIDENT_001`). The engine confirms a cause itself only when the regression test failed before the fix and passes on the verified head.
- attempts: one entry per verified commit with outcome, failure reason and diagnosis. A later success never overwrites an earlier failure.
- regression tests (with the revision and result they last ran against), commits, pull requests, affected files
- status: `OPEN → INVESTIGATING → ROOT_CAUSE_IDENTIFIED → FIX_IN_PROGRESS → VERIFIED → CLOSED`, plus `REOPENED`; a recurrence can `supersede` an earlier incident

Every write has a key, so replaying it after a crash is a no-op.

CLI: `proofloop incident list`, `incident show <id>`, `incident confirm <id> --text "…" --yes` (human only), `proofloop memory <run-id>`.

## Retrieval

Sources are searched in this order: local incidents, GitHub issues, pull requests, regression tests (from matching incidents), decision records under `docs/decisions`. Ranking is transparent: exact issue link, same error line, shared terms, shared files, matching test names, recency. Each result carries a `relevanceReason`, source URLs and a freshness flag (`CURRENT`, `POTENTIALLY_STALE` when the incident's files changed since its fix, `UNKNOWN`). A keyword match alone cannot reach the threshold, and GitHub text needs a stronger lexical match because it carries no files or revision.

Failure is never read as "no history". The result records each source as `ok`, `failed` or `skipped` and a `completeness` of `complete`, `partial` or `failed`. Failed retrieval is retried (`memory.retries`, default 2). Then, by config:

```json
{ "memory": { "requireComplete": false, "retries": 2, "maxResults": 5 } }
```

With `requireComplete: true` the run blocks rather than planning without history; otherwise it continues and the warning is recorded and shown to the planner. Retrieved text is passed to the planner as untrusted, possibly stale context: it informs the plan but never overrides the request or current evidence.

## Proof Ledger

`proofloop ledger export <run-id> --format json|markdown [--out file]`. Built only from persisted events, gate results, approvals, incident records and Git; it is not written by the agent. Schema version 1 contains: task, acceptance criteria with a status (`PASS | FAIL | NOT_RUN | BLOCKED | NOT_APPLICABLE`), investigation, implementation (plan, approvals, commits, attempts, changed files), verification rows (each with the **exact tested commit** and whether it is current for the head), the ordered event trail, and an assessment with a disposition.

Guarantees:

- Verification results name the commit they tested. A required gate whose latest result is for an earlier commit is reported as stale evidence and cannot support the head.
- Criterion status is **gate-level**: a criterion is `PASS` only when every required repository gate passes on the head; manual-only criteria are `NOT_RUN`. ProofLoop does not map individual tests to criteria beyond that.
- A task is `COMPLETED` only when nothing is failed, unverified, stale or missing. Manual-only criteria cap the disposition at `READY_FOR_REVIEW`.
- Re-exporting the same state yields the same document; there is no export timestamp. Credentials are redacted. Corrections are new events, not edits.
- The ledger and a short summary are written to `.proofloop/ledgers/<run>.json` and the run's GitHub issue when a PR is opened and when it merges; the PR body includes the summary.

## Migration

Database migration 4 adds the `incident` and `incident_entry` tables. Existing runs and state are untouched; runs created earlier have no stored memory, so the planner simply receives no historical section.

## Limits

- Retrieval is lexical and file-based (no vector search); a differently worded recurrence can be missed.
- GitHub search covers issues and pull requests, not review comments or commit messages.
- Retry has no back-off delay between attempts.
- Per-criterion verification is gate-level, as above.
