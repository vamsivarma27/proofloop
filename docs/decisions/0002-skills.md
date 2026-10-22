# 0002. Skills, not legacy commands, for the plugin surface

Status: accepted

## Context
The PRD tree lists commands/*.md. Current Claude Code docs say commands/ is legacy and prefer skills/; plugin skills are namespaced /proofloop:<name> either way.

## Decision
Ship skills/<name>/SKILL.md. State-changing skills set disable-model-invocation so only a user can trigger them. The approve skill deliberately has no allowed-tools so Claude Code prompts.

## Consequences
Command names in the PRD (/proofloop:feature, :bug, :diagnose, :performance, :verify, :status, :resume, :approve, :cancel, :protocols, :start-project, :setup) are unchanged for users.
