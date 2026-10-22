import { join } from 'node:path';
import type { AgentRequest, AgentResult, AgentRuntime } from '../agent/runtime';
import { ROLE_TOOLS } from '../agent/runtime';
import type { Config } from '../config';
import { stateDir } from '../config';
import { type BuiltinOutcome, type GateRunCtx, environmentLabel } from '../gates/runner';
import type { GithubPort, GithubSync } from '../github/adapter';
import type { Git } from '../git/git';
import { type CommandPolicy, tokenize } from '../policy/command';
import type { ProtocolRegistry } from '../protocol/registry';
import type { DetectedRepo } from '../repo/detect';
import { type Clock, systemClock } from '../shared/clock';
import { PlError } from '../shared/errors';
import type { Exec } from '../shared/exec';
import { type Logger, nullLogger } from '../shared/log';
import type { Store, TaskRun } from '../state/store';

export type BuiltinFn = (ctx: GateRunCtx) => Promise<BuiltinOutcome>;

export interface EngineDeps {
  root: string;
  store: Store;
  config: Config;
  registry: ProtocolRegistry;
  git: Git;
  runtime: AgentRuntime;
  github: GithubSync;
  port: GithubPort | null;
  detected: DetectedRepo;
  builtins: Record<string, BuiltinFn>;
  clock?: Clock;
  exec?: Exec;
  logger?: Logger;
}

export const clockOf = (d: EngineDeps): Clock => d.clock ?? systemClock;
export const loggerOf = (d: EngineDeps): Logger => d.logger ?? nullLogger;
export const environmentOf = (d: EngineDeps): string => environmentLabel(d.config.environment);
export const artifactDir = (d: EngineDeps): string => join(stateDir(d.root), 'artifacts');
export const worktreeRoot = (d: EngineDeps, runId: string): string => join(stateDir(d.root), 'worktrees', runId);

const COMMIT_TYPE: Record<string, string> = { feature: 'feat', bug: 'fix', performance: 'perf', refactor: 'refactor', security: 'security', troubleshooting: 'fix', 'idea-to-product': 'docs' };
export const commitType = (protocolId: string): string => COMMIT_TYPE[protocolId] ?? 'chore';

/** Allowlist = commands from the (human-approved) gate plan + explicit config; nothing else may run. */
export function policyFor(d: EngineDeps, runId: string): CommandPolicy {
  const fromGates = d.store.getGatePlan(runId).flatMap((g) => (g.command && !g.command.startsWith('builtin:') ? [g.command] : []));
  const allowed: string[][] = [];
  for (const line of [...fromGates, ...d.config.allowedCommands]) {
    try {
      allowed.push(tokenize(line));
    } catch {
      /* malformed allowlist entries simply never match */
    }
  }
  return { allowed };
}

export function gateCtx(d: EngineDeps, runId: string, cwd: string, commitSha: string): GateRunCtx {
  return {
    store: d.store, runId, cwd, commitSha, policy: policyFor(d, runId), git: d.git, artifactDir: artifactDir(d), timeoutMs: d.config.limits.gateTimeoutMs,
    environment: environmentLabel(d.config.environment), clock: clockOf(d), exec: d.exec, builtins: d.builtins,
  };
}

export const totalCostUsd = (d: EngineDeps, runId: string): number => d.store.events(runId, 'agent.cost').reduce((n, e) => n + Number(e.data.usd ?? 0), 0);

export function implementerTools(d: EngineDeps, runId: string): string[] {
  const cmds = policyFor(d, runId).allowed.flatMap((p) => [`Bash(${p.join(' ')})`, `Bash(${p.join(' ')} *)`]);
  return [...ROLE_TOOLS.implementer, ...cmds];
}

const RATE = /rate.?limit|\b429\b|overloaded|quota/i;
export const isRateLimited = (r: AgentResult): boolean => !r.ok && RATE.test(r.error ?? '');

/** Single choke point for model calls: enforces the run's spend budget and records cost + denials. */
export async function callAgent(d: EngineDeps, run: TaskRun, req: Omit<AgentRequest, 'maxBudgetUsd' | 'timeoutMs' | 'runId'>): Promise<AgentResult> {
  const remaining = d.config.limits.maxBudgetUsd - totalCostUsd(d, run.id);
  if (remaining <= 0) throw new PlError('PL_BUDGET_001', `run budget of $${d.config.limits.maxBudgetUsd} is exhausted`);
  const res = await d.runtime.run({ ...req, runId: run.id, maxBudgetUsd: remaining, timeoutMs: d.config.limits.agentTimeoutMs });
  d.store.audit(run.id, 'agent.cost', `agent:${req.role}`, { usd: res.costUsd ?? 0, ok: res.ok, session: res.sessionId });
  for (const denial of res.permissionDenials) d.store.audit(run.id, 'policy.denied', `agent:${req.role}`, { source: 'claude-permissions', denial });
  loggerOf(d).log(res.ok ? 'info' : 'warn', 'agent.call', { role: req.role, run: run.id, ok: res.ok, cost: res.costUsd });
  return res;
}
