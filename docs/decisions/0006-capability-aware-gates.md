# 0006. Capability-aware gate requirements

Status: accepted

## Context
AC4 says undetectable commands must be reported, not invented, yet a missing test must not count as a pass. Treating every unknown check as required would block most real repositories.

## Decision
Standard checks the repo cannot run become reported limitations below high risk and stay required at high/critical. At least one required, non-engine gate must exist or delivery is refused.

## Consequences
Small repos with only unit tests can ship at medium risk with explicit limitations; sensitive changes cannot ship on engine-only gates.
