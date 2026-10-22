# 0003. GitHub through the gh CLI, with a port

Status: accepted

## Context
The PRD wants least-privilege auth without a custom token store. gh 2.83 has no sub-issue or dependency flags, but its GraphQL API has addSubIssue and addBlockedBy.

## Decision
Implement GithubPort over `gh api`/`gh pr`. Idempotency uses hidden markers in bodies and comments plus a local outbox; sub-issue/blocked-by return unsupported instead of failing. A direct API adapter can be added behind the same port.

## Consequences
No token handling in ProofLoop. Search-based dedupe depends on GitHub search indexing latency; the local key store covers the normal case and the marker covers lost local state.
