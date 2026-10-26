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

Then show the user the plan summary and the "Gate plan preview" from the output, plus any warnings. **Do not run approve or run yourself.** End your reply with exactly this line: `Reply **approve** to run this plan (or tell me what to change).` One word from the user approves the plan and starts the whole run; after that you only follow the hook's instructions. Never describe work as passing unless a gate result in the output says PASS. If the output says BLOCKED, report the reason and evidence path verbatim. Do not restart, mutate or delete anything without explicit approval.
