import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type AgentRequest, ScriptedRuntime } from '../src/agent/runtime';
import { type Config, configSchema } from '../src/config';
import { Engine } from '../src/engine/engine';
import { createEngine } from '../src/engine/factory';
import type { GithubPort } from '../src/github/adapter';
import { approvePlan } from '../src/plan/workflow';
import type { Plan } from '../src/plan/schema';
import type { Exec } from '../src/shared/exec';
import { initRepo, tmp } from './repo-helpers';
import { validPlan } from './plan-helpers';

export const CHECK_JS = `const fs=require('fs');process.exit(fs.existsSync('feature.txt')&&fs.readFileSync('feature.txt','utf8').trim()==='ok'?0:1)`;

export async function project(over: { scripts?: Record<string, string>; files?: Record<string, string> } = {}): Promise<string> {
  const scripts = over.scripts ?? { lint: 'node -e 0', typecheck: 'node -e 0', test: 'node check.js', build: 'node -e 0' };
  return initRepo({ 'package.json': JSON.stringify({ name: 'demo', scripts }), 'check.js': CHECK_JS, 'README.md': 'demo\n', ...over.files });
}

export const featurePlan = (over: Partial<Plan> = {}): Plan =>
  validPlan({
    affectedModules: [{ path: 'feature.txt', reason: 'the feature file', status: 'confirmed' }],
    tasks: [{ id: 'task-1', title: 'Write the feature file', description: 'create feature.txt', dependencies: [], fileScopes: ['feature.txt'], acceptanceCriteria: ['AC-1'], risk: 'medium', doneWhen: 'npm test passes' }],
    acceptanceCriteria: [{ id: 'AC-1', text: 'feature.txt contains ok', tests: ['check.js'] }],
    ...over,
  });

export type Handler = (req: AgentRequest, n: number) => Record<string, unknown> | Promise<Record<string, unknown>>;

export function write(cwd: string, rel: string, content: string): void {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), content);
}

const APPROVE = { verdict: 'approve', findings: [], unsupportedClaims: [] };

/** Default fake agents: valid plan, implementer writes feature.txt, reviewer approves. */
export function agents(over: { plan?: Plan; implement?: (req: AgentRequest, n: number) => void | Promise<void>; review?: Record<string, unknown> | ((req: AgentRequest) => Record<string, unknown>) } = {}): ScriptedRuntime {
  let impl = 0;
  return new ScriptedRuntime(async (req) => {
    if (req.role === 'planner') return { structured: over.plan ?? featurePlan() };
    if (req.role === 'implementer') {
      impl++;
      if (over.implement) await over.implement(req, impl);
      else write(req.cwd, 'feature.txt', 'ok\n');
      return { text: 'done', costUsd: 0.01 };
    }
    const r = typeof over.review === 'function' ? over.review(req) : (over.review ?? APPROVE);
    return { structured: r, costUsd: 0.01 };
  });
}

export async function engineFor(root: string, runtime: ScriptedRuntime, o: { config?: Partial<Config>; port?: GithubPort | null; exec?: Exec; dbFile?: string; clock?: import('../src/shared/clock').Clock } = {}): Promise<Engine> {
  return createEngine({ root, runtime, port: o.port ?? null, config: configSchema.parse({ ...o.config, limits: { gateTimeoutMs: 30_000, ...(o.config?.limits ?? {}) } }), exec: o.exec, dbFile: o.dbFile, clock: o.clock });
}

/** start -> drive to approval -> approve (as a human) -> drive. */
export async function approveAndRun(e: Engine, intent = 'Add the feature file'): Promise<{ runId: string; first: Awaited<ReturnType<Engine['drive']>>; final: Awaited<ReturnType<Engine['drive']>> }> {
  const run = await e.start({ protocolId: 'feature', intent });
  const first = await e.drive(run.id);
  approvePlan(e.d.store, run.id, { planHash: e.d.store.getRun(run.id).currentPlanHash!, by: 'human:tester' });
  return { runId: run.id, first, final: await e.drive(run.id) };
}

export { tmp };
