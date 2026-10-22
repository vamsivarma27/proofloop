# Contributing

1. Read [CLAUDE.md](CLAUDE.md) (invariants) and [GETTING_STARTED.md](GETTING_STARTED.md).
2. Branch from `develop`: `feature/<desc>`, `bugfix/<desc>`, `task/<desc>`. Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `security:`, `perf:`, `chore:`), subject ≤ 72 chars, imperative, no trailing period. Link issues with `Closes #N`.
3. Every change updates or adds tests and runs them green. Coverage gate: ≥ 80 % lines (blocking). Lint and typecheck have zero errors.
4. Never bypass hooks (`--no-verify`). Fixtures that resemble credentials are built at runtime.
5. PRs need a milestone, labels, a peer approval from someone who is not the author, and no self-merge. Changes to approval transitions, command/path policy, secret handling, gates, or the sandbox need dedicated tests and explicit maintainer review.
6. New user-facing behaviour is documented. Rebuild `dist/` (`pnpm build`); CI fails if it is out of date.

Adding a protocol or adapter does not require engine changes: see [protocol authoring](docs/guides/protocol-authoring.md) and [adapters](docs/guides/adapters.md).
