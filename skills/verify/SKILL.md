---
name: verify
description: Run the repository detected quality gates on the current commit and report evidence.
argument-hint: ""
disable-model-invocation: true
allowed-tools: Bash(proofloop *)
---

Run `proofloop verify` and report the gate table exactly. If a gate is BLOCKED because no command was detected, say so; do not invent one. The working tree must be committed first.
