---
name: performance
description: Run the ProofLoop performance protocol: baseline, one change, before/after against a stated target.
argument-hint: "[slow operation, workload, target]"
disable-model-invocation: true
allowed-tools: Bash(proofloop *)
---

Run:

```
proofloop performance "$ARGUMENTS"
```

Then show the user the plan summary and the "Gate plan preview" from the output, plus any warnings. **Do not approve anything yourself.** Tell them to review and, when satisfied, run `/proofloop:approve <run-id>`. Never describe work as passing unless a gate result in the output says PASS. If the output says BLOCKED, report the reason and evidence path verbatim. Never claim an improvement without recorded before/after numbers and a stated target.
