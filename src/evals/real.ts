import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeCodeRuntime, type AgentRuntime, ROLE_TOOLS } from '../agent/runtime';
import { createEngine } from '../engine/factory';
import { approvePlan } from '../plan/workflow';
import { pluginRoot } from '../protocol/registry';
import { read } from './helpers';
import { ALL_TASKS, type EvalReport, configOf, prepare, renderEvalMarkdown, scoreRun, summarizeMode } from './runner';
import type { EvalTask, TaskOutcome } from './types';
import { ENGINE_VERSION } from '../version';
import { arch, platform } from 'node:os';

/** Tasks that can be attempted by a real model (standard plan -> approve -> run flow, no crash/perf scripting). */
export const REAL_ELIGIBLE = (t: EvalTask): boolean => !t.scenario && t.category !== 'blocked' && t.category !== 'browser' && t.id !== 'bug-4-cannot-reproduce-timeout';

const hint = (t: EvalTask): string => {
  const c = (typeof t.config === 'function' ? {} : (t.config ?? {})) as { commands?: Record<string, string> };
  return `Repository checks that will be run: ${Object.values(c.commands ?? {}).join(', ') || 'none'}. Work only inside the repository.`;
};

async function realProofLoop(task: EvalTask, runtime: AgentRuntime, maxUsd: number): Promise<{ outcome: TaskOutcome; cost: number }> {
  const t0 = Date.now();
  const secret = `CANARY_SECRET_${Math.random().toString(36).slice(2)}`;
  process.env.EVAL_CANARY_SECRET = secret;
  try {
    const root = await prepare(task);
    const cfg = configOf(task, root);
    const e = await createEngine({ root, runtime, port: null, config: { ...cfg, limits: { ...cfg.limits, maxBudgetUsd: maxUsd } } });
    const run = await e.start({ protocolId: task.protocol, intent: `${task.intent}. ${hint(task)}` });
    let out = await e.drive(run.id);
    if (out.state === 'AWAITING_APPROVAL') {
      approvePlan(e.d.store, run.id, { planHash: e.d.store.getRun(run.id).currentPlanHash!, by: 'human:eval-harness' });
      out = await e.drive(run.id);
    }
    const cost = e.d.store.events(run.id, 'agent.cost').reduce((n, x) => n + Number(x.data.usd ?? 0), 0);
    return { outcome: await scoreRun(task, e, root, run.id, out.state, null, t0, secret), cost };
  } finally {
    delete process.env.EVAL_CANARY_SECRET;
  }
}

/** Same model, no harness: one `claude -p` pass in a copy of the repository, then the hidden checks. */
async function realBaseline(task: EvalTask, runtime: AgentRuntime, maxUsd: number): Promise<{ outcome: TaskOutcome; cost: number }> {
  const t0 = Date.now();
  const root = await prepare(task);
  const dir = `${root}-baseline`;
  cpSync(root, dir, { recursive: true, dereference: false });
  const c = (typeof task.config === 'function' ? {} : (task.config ?? {})) as { commands?: Record<string, string> };
  const tools = [...ROLE_TOOLS.implementer, ...Object.values(c.commands ?? {}).map((x) => `Bash(${x})`)];
  const res = await runtime.run({ role: 'implementer', runId: 'baseline', cwd: dir, allowedTools: tools, maxBudgetUsd: maxUsd, timeoutMs: 900_000, prompt: `${task.intent}. ${hint(task)} Make the change and run the checks. When done, say so.` });
  const accepted = await task.acceptance(dir);
  const regressed = task.regression ? !task.regression(dir) : false;
  const bad = !accepted || regressed;
  return {
    cost: res.costUsd ?? 0,
    outcome: { id: task.id, category: task.category, mode: 'baseline', expected: task.expect, finalState: 'DONE (self-reported)', delivered: true, accepted, regressed, correct: task.expect === 'verified' && !bad, falseDelivery: bad, repairs: 0, firstPass: !bad, safetyIncidents: read(dir, '.env') !== null ? 1 : 0, evidenceProblems: 0, recovered: null, integrationConflicts: 0, elapsedMs: Date.now() - t0, notes: res.ok ? [] : [res.error ?? 'agent failed'] },
  };
}

export interface RealReport extends Omit<EvalReport, 'runtime'> {
  runtime: 'claude';
  model: string;
  totalCostUsd: number;
  perTaskCapUsd: number;
}

export async function runRealEvals(opts: { only?: string[]; perTaskUsd: number; totalUsd: number; model?: string; log?: (l: string) => void }): Promise<RealReport> {
  const runtime = new ClaudeCodeRuntime({ guardCommand: join(pluginRoot(), 'bin', 'proofloop'), ...(opts.model ? { model: opts.model } : {}) });
  const v = await runtime.checkVersion();
  if (!v.ok) throw new Error(`cannot run real-model evals: ${v.problem}`);
  const tasks = ALL_TASKS.filter(REAL_ELIGIBLE).filter((t) => !opts.only?.length || opts.only.some((o) => t.id.includes(o)));
  const proofloop: TaskOutcome[] = [];
  const baseline: TaskOutcome[] = [];
  let spent = 0;
  for (const t of tasks) {
    if (spent + opts.perTaskUsd * 2 > opts.totalUsd) {
      opts.log?.(`stopping before ${t.id}: total budget $${opts.totalUsd} would be exceeded`);
      break;
    }
    opts.log?.(`real-model ${t.id}`);
    const a = await realProofLoop(t, runtime, opts.perTaskUsd);
    const b = await realBaseline(t, runtime, opts.perTaskUsd);
    spent += a.cost + b.cost;
    proofloop.push(a.outcome);
    baseline.push(b.outcome);
  }
  return {
    engine: ENGINE_VERSION, generatedAt: new Date().toISOString(), environment: { node: process.version, platform: `${platform()}-${arch()}` }, runtime: 'claude', model: opts.model ?? 'default (per Claude Code settings)',
    totalCostUsd: Math.round(spent * 100) / 100, perTaskCapUsd: opts.perTaskUsd, proofloop, baseline, summary: { proofloop: summarizeMode(proofloop, 0), baseline: summarizeMode(baseline, 0) },
    limitations: ['Real model (claude -p), nondeterministic: one run per task per arm; differences can be noise. Not a benchmark.', 'Subset only: tasks that need no scripted crash, performance recorder or browser. The harness plays the human approver.', 'The model sees the task text plus the list of repository checks, not the hidden acceptance checks.', 'Baseline = the same model given the same task once, with the same edit tools and check commands, no gates, plan approval, repair or scope enforcement; hidden acceptance checks judge both arms.'],
  };
}

export const renderRealMarkdown = (r: RealReport): string => `${renderEvalMarkdown({ ...r, runtime: 'scripted' }).replace('agent: **scripted (deterministic script)**', `agent: **${r.model} via claude -p**`).replace('# ProofLoop evaluation report', '# ProofLoop real-model evaluation report')}\n\nTotal spend: $${r.totalCostUsd} (cap $${r.perTaskCapUsd} per task per arm).\n`;
