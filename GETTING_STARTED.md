# Getting started (contributors)

```bash
git clone https://github.com/vamsivarma27/proofloop && cd proofloop
corepack enable && pnpm install
git config core.hooksPath .githooks       # gitleaks + typecheck + lint on every commit; do not bypass
pnpm check                                # typecheck, lint, tests with coverage gate, build
./bin/proofloop protocols                 # smoke test the CLI
./bin/proofloop eval feature-1            # one scripted eval task
```

Needs: Node ≥ 22.13 (Node ≥ 25 enables the sandbox tests), Git, `gitleaks` (optional locally, required in CI), Google Chrome for the browser evals. `gh` is only needed to exercise GitHub flows.

Try the plugin in a scratch repo: `cd /path/to/scratch && claude --plugin-dir /path/to/proofloop`, then `/proofloop:setup`.

Where things are: see [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md). Rules: [CLAUDE.md](CLAUDE.md). Before opening a PR: tests added/updated and green, `dist/` rebuilt, docs updated when behaviour changes, no secrets, milestone and labels set, and a peer who is not the author approves.
