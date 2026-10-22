# 0005. One package with enforced module boundaries

Status: accepted

## Context
The PRD proposes a pnpm workspace with many packages. It also says the layout is a recommendation.

## Decision
A single package with one directory per module and a bundle (dist/cli.js) that the plugin ships. Boundaries are conventions backed by contract tests, not package walls.

## Consequences
Less ceremony for a one-maintainer start. Splitting later is mechanical because modules only depend downward (state <- policy/gates <- engine <- cli).
