# 0007. Approval is a human actor bound to a plan hash

Status: accepted

## Context
An agent with shell access could otherwise call the approval command itself.

## Decision
The store accepts approvals only from human:* actors, matched to the current plan hash. Agent sessions are denied approval/state commands by hook and disallow list; interactive approval surfaces a permission prompt; non-interactive approval needs --yes or a TTY confirmation.

## Consequences
In a session run with permissions bypassed the prompt is gone (documented residual risk).
