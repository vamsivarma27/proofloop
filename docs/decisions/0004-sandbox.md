# 0004. Code Mode sandbox fails closed

Status: accepted

## Context
Model-written programs must not get ambient fs, process, network or credentials. node:vm is not a security boundary. Node 25 added network denial to the permission model; Node 22/24 lack it.

## Decision
Run programs in a child with --permission (no writes, spawn, workers, net), empty env, JSON-line tool bridge, host-side validation and limits. If the Node cannot deny network, refuse to run. The Cloudflare adapter exists only as a disabled stub because upstream is experimental and unverified here.

## Consequences
Code Mode is Node >= 25 only. Core protocols never depend on it, which a test asserts.
