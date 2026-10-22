---
name: resume
description: Resume an interrupted, paused or blocked ProofLoop run after reconciling Git state.
argument-hint: "<run-id> [--retry]"
disable-model-invocation: true
allowed-tools: Bash(proofloop *)
---

Run `proofloop resume $ARGUMENTS` and report the outcome. Use --retry only after the user confirms the blocker is resolved.
