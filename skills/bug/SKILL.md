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

Then show the user the whole plan from the output (at a glance, tasks, acceptance criteria, commands) and the "Gate plan preview", plus any warnings. **Do not approve anything yourself.** Tell them to review and, when satisfied, run `/proofloop:approve <run-id>`. Never describe work as passing unless a gate result in the output says PASS. If the output says BLOCKED, report the reason and evidence path verbatim. If the bug could not be reproduced, ask the user for the missing details instead of proposing a fix.
