---
name: ledger
description: Export the Proof Ledger for a run (JSON or Markdown), or show the history ProofLoop retrieved before planning.
argument-hint: "<run-id> [json|markdown]"
disable-model-invocation: true
allowed-tools: Bash(proofloop *)
---

Run `proofloop ledger export $ARGUMENTS` (default JSON; add `--format markdown` for the readable form). Report the disposition, the criteria that are verified, failed or unverified, and any stale or missing evidence. To see the retrieved history, run `proofloop memory <run-id>`; to inspect past incidents, run `proofloop incident list`. Do not edit or summarize away failed attempts.
