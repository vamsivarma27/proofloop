---
name: test
description: When the user says "test", "run tests", "test everything" or names checks (unit, browser, ...), run the ProofLoop full project test - every check on the current commit, Playwright journeys per persona, and a regression comparison with the base branch - then log, report and file bugs.
argument-hint: "[unit|lint|typecheck|build|integration|browser|security-scan|migration ...] [--no-baseline] [--file-bugs]"
allowed-tools: Bash(proofloop *), Bash(git status*), Bash(git add*), Bash(git commit*)
---

Do not ask which suites; run the test. If the user named checks, pass them; otherwise run everything.

1. The working tree must be committed (evidence maps to a commit). If it is dirty, tell the user and offer to commit; do not commit on your own.
2. Run in the foreground with the Bash timeout set to 600000 ms (never in the background: its output file is outside the repository and ProofLoop's path policy refuses to read it):

```
proofloop test $ARGUMENTS
```

This runs lint, typecheck, unit (the full regression suite), build, integration, the browser gate (the repository's Playwright tests, once per persona: ordinary-user, impatient-user, unauthorized-user, accessibility), security-scan and migration, on the current commit AND on the merge base with the default branch. A check that passed on the base and fails now is a **regression**; failing on both is **pre-existing**.

3. Report the table exactly as printed, every bug, every "not covered" gap, and the paths to `report.md` and the gate logs. Never call anything passing unless the output says PASS. A BLOCKED check is not a pass.
4. If the browser check is a gap (no Playwright tests, no app start command), say so plainly, then offer to add them as a normal change: propose the user journeys (main success path, error, empty and permission states) derived from the app's routes and acceptance criteria, and on approval run `/proofloop:feature "Add Playwright journeys for ..."`. Tag tests `@AC-n` so they map to acceptance criteria. Never write or edit tests to hide a failure.
5. Add `--file-bugs` only when the user asks for GitHub issues.

ProofLoop's own end-to-end self-suites are a different command: `proofloop selftest`.
