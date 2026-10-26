---
name: status
description: Show active ProofLoop runs, gates, retries and blockers.
argument-hint: "[run-id]"
disable-model-invocation: true
allowed-tools: Bash(proofloop *)
---

Run `proofloop status $ARGUMENTS` (or `proofloop wait <id>` to follow a running run) and summarize: state, failing gate, retries used, unsynced GitHub writes, and the suggested next action.
