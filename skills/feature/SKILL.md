---
name: feature
description: Run the ProofLoop feature protocol: discover, plan, wait for approval, implement in an isolated worktree, verify with real gates.
argument-hint: "[what to build]"
disable-model-invocation: true
allowed-tools: Bash(proofloop *)
---

Run this and wait for it to finish (it can take several minutes; use a long timeout or run it in the background and poll):

```
proofloop feature "$ARGUMENTS"
```

Then show the user the plan summary and the "Gate plan preview" from the output, plus any warnings. **Do not approve anything yourself.** Tell them to review and, when satisfied, run `/proofloop:approve <run-id>`. Never describe work as passing unless a gate result in the output says PASS. If the output says BLOCKED, report the reason and evidence path verbatim.
