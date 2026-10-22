---
name: setup
description: Check the environment and create a minimal .proofloop config (asks before writing).
argument-hint: ""
disable-model-invocation: true
allowed-tools: Bash(proofloop *)
---

Run `proofloop setup` (read-only). Show the self-check and what would be written. Only if the user agrees, run `proofloop setup --yes`. Do not install dependencies or change repository files.
