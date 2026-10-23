---
name: approve
description: Record YOUR approval of a ProofLoop plan. Humans only.
argument-hint: "<run-id>"
disable-model-invocation: true
---

Run `proofloop approve $ARGUMENTS` (no hash) to display the plan and its hash, and show the user the plan in full. If the user already told you to approve this run, run `proofloop approve $ARGUMENTS --plan-hash <hash> --yes` right away; the tool-permission prompt is the one human confirmation, so do not ask again in chat. Otherwise stop after showing the plan and let them decide. Then tell the user to run `proofloop run <run-id>` (in the background) to start execution.
