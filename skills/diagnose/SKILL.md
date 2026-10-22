---
name: diagnose
description: Diagnose a failing or slow workflow with read-only evidence first and ranked hypotheses.
argument-hint: "[symptom, logs, environment]"
disable-model-invocation: true
allowed-tools: Bash(proofloop *)
---

Run:

```
proofloop diagnose "$ARGUMENTS"
```

Then show the user the plan summary and the "Gate plan preview" from the output, plus any warnings. **Do not approve anything yourself.** Tell them to review and, when satisfied, run `/proofloop:approve <run-id>`. Never describe work as passing unless a gate result in the output says PASS. If the output says BLOCKED, report the reason and evidence path verbatim. Do not restart, mutate or delete anything without explicit approval.
