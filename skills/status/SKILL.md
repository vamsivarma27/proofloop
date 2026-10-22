---
name: status
description: Show active ProofLoop runs, gates, retries and blockers.
argument-hint: "[run-id]"
disable-model-invocation: true
allowed-tools: Bash(proofloop *)
---

Run `proofloop status $ARGUMENTS` and summarize: state, failing gate, retries used, unsynced GitHub writes, and the suggested next action.
