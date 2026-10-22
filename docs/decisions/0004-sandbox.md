# 0004. Code Mode sandbox fails closed

Status: accepted

## Context
Model-written programs must not get ambient fs, process, network or credentials. node:vm is not a security boundary. Node 25 added network denial to the permission model; Node 22/24 lack it.

## Decision
Run programs in a child with --permission (no writes, spawn, workers, net), empty env, JSON-line tool bridge, host-side validation and limits. If the Node cannot deny network, refuse to run. The Cloudflare adapter exists only as a disabled stub because upstream is experimental and unverified here.

## Consequences
Code Mode is Node >= 25 only. Core protocols never depend on it, which a test asserts.

## Update
The Cloudflare adapter is now a bridge to a user-deployed Worker over a contract ProofLoop defines, sharing the same host-side tool rules (`src/composer/host.ts`). It needs two explicit opt-ins because tool results leave the machine, and it is verified only against a local mock. See docs/guides/cloudflare-bridge.md.
