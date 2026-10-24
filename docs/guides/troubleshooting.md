# Troubleshooting and recovery

| Symptom | Meaning | Do |
|---|---|---|
| `BLOCKED: no required gate can run` | the repo has no detectable lint/type/test/build (a missing test is not a pass) | set `commands.*` in `.proofloop/config.json`, or add the commands to the approved plan's `gateCommands` |
| `BLOCKED … identical failure repeated` | the same gate failed the same way after a repair | read `proofloop report <id>` and the evidence log paths; fix by hand or re-plan |
| `BLOCKED … cannot be fixed by editing code: x=BLOCKED/environment` | a tool, browser, credential or service is missing | fix the environment, then `proofloop resume <id> --retry` |
| `PAUSED` | rate limit/quota or a user pause | `proofloop resume <id>` |
| `AWAITING_APPROVAL` | waiting for you | review the plan, then reply `approve` in chat (terminal: `proofloop approve <id> --plan-hash <hash>` then `proofloop run <id>`) |
| `REVIEW_REQUIRED … waiting: github` | push/PR creation failed (auth, remote, network) | fix, then `proofloop resume <id>`; nothing is queued silently |
| `PR_OPEN` | waiting for a human to merge | merge; `proofloop resume <id>` records completion |
| `worktree … is missing` | the worktree directory was deleted | the branch is intact; `resume --retry` recreates it |
| `sandbox unavailable` | Code Mode needs Node ≥ 25 (network denial) | upgrade Node or ignore; core protocols are unaffected |

**Interrupted run:** run `proofloop resume <id>`. It marks running steps interrupted, checks the worktree HEAD against the recorded commit, keeps partial edits, releases leases of dead workers, redoes only unfinished tasks, and never marks anything complete without fresh green gates.

**Where evidence lives:** `.proofloop/artifacts/<run>/` (redacted logs, checksummed), `.proofloop/state.db` (SQLite), `.proofloop/logs/proofloop.log` (JSON lines, redacted), `.proofloop/reports/`. Delete a finished run's artifacts any time; GitHub comments and issues remain in GitHub history. `retentionDays` is advisory metadata for your own cleanup; ProofLoop does not delete files by itself.

**Uninstall:** remove the plugin (`claude plugin uninstall proofloop`), then delete `.proofloop/` and `git worktree prune` in repositories you used it in. ProofLoop writes nothing else to your repository except branches it created and `.git/info/exclude` entries.
