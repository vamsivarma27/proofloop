---
name: approve
description: Record YOUR approval of a ProofLoop plan. Humans only.
argument-hint: "<run-id>"
disable-model-invocation: true
---

First run `proofloop approve $ARGUMENTS` (no hash) to display the current plan and its hash. Ask the user to confirm they reviewed it. Only after the user explicitly says to approve, run `proofloop approve $ARGUMENTS --plan-hash <hash> --yes`. The tool-permission prompt is the human confirmation; never skip it. Then tell the user to run `proofloop run <run-id>` (in the background) to start execution.
