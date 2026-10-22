import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plan } from '../plan/schema';

export const write = (cwd: string, rel: string, content: string): void => {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), content);
};

export const read = (dir: string, rel: string): string | null => {
  try {
    return readFileSync(join(dir, rel), 'utf8');
  } catch {
    return null;
  }
};

/** Runs a node script in `dir`; true iff it exits 0. Used for hidden acceptance checks. */
export const nodeOk = (dir: string, args: string[], timeout = 30_000): boolean => {
  try {
    execFileSync(process.execPath, args, { cwd: dir, stdio: 'pipe', timeout, env: { PATH: process.env.PATH ?? '' } });
    return true;
  } catch {
    return false;
  }
};

export const nodeEval = (dir: string, code: string): boolean => nodeOk(dir, ['--disable-warning=ExperimentalWarning', '-e', code]);

interface PlanSpec {
  summary: string;
  modules: string[];
  acs: Array<{ id: string; text: string; tests: string[] }>;
  tasks: Array<{ id: string; title: string; scopes: string[]; deps?: string[]; acs: string[] }>;
  extra?: Partial<Plan>;
}

export function mkPlan(o: PlanSpec): Plan {
  return {
    schemaVersion: 1,
    intent: { summary: o.summary, outcome: `${o.summary}, verified by tests`, constraints: [], nonGoals: [] },
    assumptions: [],
    affectedModules: o.modules.map((path) => ({ path, reason: 'target of the change', status: 'confirmed' as const })),
    acceptanceCriteria: o.acs,
    testPlan: [{ id: 'T-1', kind: 'unit', description: 'repository tests', gateId: 'unit' }],
    risk: { level: 'medium', rationale: 'ordinary change to application code' },
    tasks: o.tasks.map((t) => ({ id: t.id, title: t.title, description: `implement ${t.title}`, dependencies: t.deps ?? [], fileScopes: t.scopes, acceptanceCriteria: t.acs, risk: 'medium' as const, doneWhen: 'repository checks pass' })),
    gateCommands: {},
    ...o.extra,
  };
}

export const BASIC_CONFIG = { commands: { lint: 'node -e 0', typecheck: 'node -e 0', unit: 'node check.js', build: 'node -e 0' } };
export const PKG = JSON.stringify({ name: 'fixture', version: '1.0.0' });
