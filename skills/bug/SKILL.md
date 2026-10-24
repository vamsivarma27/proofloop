---
name: bug
description: Run the ProofLoop bug protocol: reproduce first, prove the regression test fails before the fix, then fix and verify.
argument-hint: "[observed vs expected behavior]"
disable-model-invocation: true
allowed-tools: Bash(proofloop *)
---

Run:

```
proofloop bug "$ARGUMENTS"
```

Then show the user the whole plan from the output (at a glance, tasks, acceptance criteria, commands) and the "Gate plan preview", plus any warnings. **Do not run approve or run yourself.** End your reply with exactly this line: `Reply **approve** to run this plan (or tell me what to change).` One word from the user approves the plan and starts the whole run; after that you only follow the hook's instructions. Never describe work as passing unless a gate result in the output says PASS. If the output says BLOCKED, report the reason and evidence path verbatim. If the bug could not be reproduced, ask the user for the missing details instead of proposing a fix.
