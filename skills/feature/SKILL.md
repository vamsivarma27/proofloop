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

Then show the user the whole plan from the output (at a glance, tasks, acceptance criteria, commands) and the "Gate plan preview", plus any warnings. **Do not run approve or run yourself.** End your reply with exactly this line: `Reply **approve** to run this plan (or tell me what to change).` One word from the user approves the plan and starts the whole run; after that you only follow the hook's instructions. Never describe work as passing unless a gate result in the output says PASS. If the output says BLOCKED, report the reason and evidence path verbatim.
