---
name: test
description: When the user says just "test", "run tests", "test all" or names suites, run ProofLoop end-to-end test suites (all, or the ones you name), log what happened, list bugs, and optionally file them as GitHub issues.
argument-hint: "[all | feature bug integration browser performance recovery blocked] [--file-bugs owner/repo]"
allowed-tools: Bash(proofloop *)
---

If the user named no suite, run `proofloop test --list` and ask which to run (offer "all"). Then run it in the foreground with the Bash timeout set to 600000 ms (a full run takes about a minute or two). Do not run it in the background: its output file is outside the repository and ProofLoop's path policy will refuse to read it.

```
proofloop test $ARGUMENTS
```

Each suite drives real runs through the full engine (plan, approval, implementation, gates, review, delivery, recovery) with a deterministic scripted agent, so this tests ProofLoop itself, not model quality. Report the pass/fail table and every bug exactly as printed, and give the paths to `report.md` and `log.jsonl`. Add `--file-bugs owner/repo` only if the user asks for issues to be created. Never call a suite passing unless the output says so.

These suites test ProofLoop itself. To check the user's own project, point them to `/proofloop:verify` (runs the repository's real gates on the current commit).
