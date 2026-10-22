import { FakeClock } from '../src/shared/clock';
import { openDb } from '../src/state/db';
import { Store } from '../src/state/store';
import type { TaskRun } from '../src/state/store';
import type { TaskState } from '../src/state/machine';

export function makeStore(path = ':memory:'): { store: Store; clock: FakeClock } {
  const clock = new FakeClock();
  return { store: new Store(openDb(path), clock), clock };
}

export function newRun(store: Store, over: { idempotencyKey?: string; repairBudget?: number } = {}): TaskRun {
  const projectId = store.ensureProject({ name: 'demo', repository: null, defaultBranch: 'main' });
  return store.createRun({ projectId, protocolId: 'feature', protocolVersion: '1.0.0', intent: 'add x', risk: 'medium', repairBudget: over.repairBudget ?? 2, ...over });
}

const A = { actor: 'test' };

export function advance(store: Store, id: string, ...states: TaskState[]): void {
  for (const s of states) store.transition(id, s, A);
}

/** Drives a run to RUNNING with an approved plan and a one-gate plan. */
export function toRunning(store: Store, id: string): void {
  advance(store, id, 'DISCOVERING', 'PLANNING');
  store.recordPlan(id, { v: 1 }, 'hash1');
  advance(store, id, 'AWAITING_APPROVAL');
  store.recordApproval(id, { scope: 'plan', planHash: 'hash1', approvedBy: 'human:test', decision: 'approve' });
  advance(store, id, 'APPROVED', 'READY', 'RUNNING');
  store.setGatePlan(id, [{ gateId: 'unit', kind: 'unit', required: true, command: 'pnpm test' }]);
  store.setFields(id, { headSha: 'abc123' });
}

export function gate(store: Store, id: string, state: 'PASS' | 'FAIL' | 'BLOCKED', commitSha = 'abc123', gateId = 'unit'): void {
  store.recordGateResult({ taskRunId: id, gateId, state, required: true, commandOrAssertion: 'pnpm test', exitCode: state === 'PASS' ? 0 : 1, evidenceIds: [], commitSha, startedAtUtc: 't0', finishedAtUtc: 't1' });
}
