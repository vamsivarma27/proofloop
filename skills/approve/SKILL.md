---
name: approve
description: Approve the pending ProofLoop plan and start the run. Same as replying "approve".
argument-hint: "[run-id]"
disable-model-invocation: true
allowed-tools: Bash(proofloop *)
---

The approval is recorded by the ProofLoop hook from the user's own message, not by you. If the hook context says the plan was approved and the run started, follow it: run `proofloop wait <run-id>` until the run ends, then `proofloop report <run-id>` and summarize. Do not ask for confirmation again.

If there is no such context, nothing is awaiting approval: run `proofloop status` and tell the user the state in one line.
