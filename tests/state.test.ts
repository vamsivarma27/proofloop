import { FAKE_GH_TOKEN } from './fake-secrets';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATES, allowedTransitions, isAllowedTransition } from '../src/state/machine';
import { isPlError } from '../src/shared/errors';
import { advance, gate, makeStore, newRun, toRunning } from './helpers';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return isPlError(e) ? e.code : 'OTHER';
  }
  return undefined;
};

describe('transition table', () => {
  it('has no outgoing edges from terminal states', () => {
    expect(allowedTransitions('COMPLETE')).toEqual([]);
    expect(allowedTransitions('CANCELLED')).toEqual([]);
  });

  it('allows the documented extra edges', () => {
    expect(isAllowedTransition('RUNNING', 'BLOCKED')).toBe(true);
    expect(isAllowedTransition('VERIFYING', 'REPAIRING')).toBe(true);
    expect(isAllowedTransition('REPAIRING', 'RUNNING')).toBe(true);
    expect(isAllowedTransition('PR_OPEN', 'REPAIRING')).toBe(true);
    expect(isAllowedTransition('RUNNING', 'PAUSED')).toBe(true);
    expect(isAllowedTransition('PAUSED', 'READY')).toBe(true);
  });

  it('rejects every transition from NEW that is not in the table', () => {
    for (const to of STATES) {
      const { store } = makeStore();
      const run = newRun(store);
      const expected = isAllowedTransition('NEW', to) ? undefined : 'PL_STATE_001';
      expect(code(() => store.transition(run.id, to, { actor: 't' }))).toBe(expected);
    }
  });
});

describe('guards', () => {
  it('cannot start implementation before approval is recorded (AC2)', () => {
    const { store } = makeStore();
    const run = newRun(store);
    advance(store, run.id, 'DISCOVERING', 'PLANNING');
    store.recordPlan(run.id, { v: 1 }, 'h1');
    advance(store, run.id, 'AWAITING_APPROVAL');
    expect(code(() => store.transition(run.id, 'APPROVED', { actor: 'agent' }))).toBe('PL_STATE_011');
    expect(code(() => store.transition(run.id, 'RUNNING', { actor: 'agent' }))).toBe('PL_STATE_001');
    expect(store.getRun(run.id).state).toBe('AWAITING_APPROVAL');
    expect(store.events(run.id, 'transition.denied').length).toBe(2);
  });

  it('rejects approval of a stale plan hash and re-approval after an edit', () => {
    const { store } = makeStore();
    const run = newRun(store);
    advance(store, run.id, 'DISCOVERING', 'PLANNING');
    store.recordPlan(run.id, { v: 1 }, 'h1');
    advance(store, run.id, 'AWAITING_APPROVAL');
    expect(code(() => store.recordApproval(run.id, { scope: 'plan', planHash: 'old', approvedBy: 'human:t', decision: 'approve' }))).toBe('PL_PLAN_003');
    store.recordApproval(run.id, { scope: 'plan', planHash: 'h1', approvedBy: 'human:t', decision: 'approve' });
    advance(store, run.id, 'APPROVED');
    advance(store, run.id, 'READY');
    // editing the plan is only possible by going back to PLANNING; the old approval no longer matches
    expect(code(() => store.recordPlan(run.id, { v: 2 }, 'h2'))).toBe('PL_PLAN_001');
  });

  it('a rejected-then-edited plan needs a fresh approval', () => {
    const { store } = makeStore();
    const run = newRun(store);
    advance(store, run.id, 'DISCOVERING', 'PLANNING');
    store.recordPlan(run.id, { v: 1 }, 'h1');
    advance(store, run.id, 'AWAITING_APPROVAL');
    store.recordApproval(run.id, { scope: 'plan', planHash: 'h1', approvedBy: 'human:t', decision: 'reject', comment: 'no' });
    advance(store, run.id, 'PLANNING');
    store.recordPlan(run.id, { v: 2 }, 'h2');
    advance(store, run.id, 'AWAITING_APPROVAL');
    expect(code(() => store.transition(run.id, 'APPROVED', { actor: 'a' }))).toBe('PL_STATE_011');
    expect(store.getRun(run.id).planVersion).toBe(2);
  });

  it('a failing required gate can never reach COMPLETE (AC7)', () => {
    const { store } = makeStore();
    const run = newRun(store);
    toRunning(store, run.id);
    advance(store, run.id, 'VERIFYING');
    gate(store, run.id, 'FAIL');
    expect(code(() => store.transition(run.id, 'REVIEW_REQUIRED', { actor: 'a' }))).toBe('PL_STATE_022');
    expect(code(() => store.transition(run.id, 'COMPLETE', { actor: 'a' }))).toBe('PL_STATE_001');
  });

  it('BLOCKED, missing and stale gates are not passes', () => {
    const { store } = makeStore();
    const run = newRun(store);
    toRunning(store, run.id);
    advance(store, run.id, 'VERIFYING');
    expect(code(() => store.transition(run.id, 'REVIEW_REQUIRED', { actor: 'a' }))).toBe('PL_STATE_022'); // missing
    gate(store, run.id, 'BLOCKED');
    expect(code(() => store.transition(run.id, 'REVIEW_REQUIRED', { actor: 'a' }))).toBe('PL_STATE_022');
    gate(store, run.id, 'PASS', 'oldsha');
    expect(code(() => store.transition(run.id, 'REVIEW_REQUIRED', { actor: 'a' }))).toBe('PL_STATE_022'); // stale commit
  });

  it('refuses a vacuous pass when no required gates are planned', () => {
    const { store } = makeStore();
    const run = newRun(store);
    toRunning(store, run.id);
    store.setGatePlan(run.id, []);
    advance(store, run.id, 'VERIFYING');
    expect(code(() => store.transition(run.id, 'REVIEW_REQUIRED', { actor: 'a' }))).toBe('PL_STATE_021');
  });

  it('walks the whole happy path to COMPLETE only with green gates and a PR', () => {
    const { store } = makeStore();
    const run = newRun(store);
    toRunning(store, run.id);
    advance(store, run.id, 'VERIFYING');
    gate(store, run.id, 'PASS');
    advance(store, run.id, 'REVIEW_REQUIRED');
    expect(code(() => store.transition(run.id, 'PR_OPEN', { actor: 'a' }))).toBe('PL_STATE_040');
    store.setFields(run.id, { prUrl: 'https://example/pr/1' });
    advance(store, run.id, 'PR_OPEN', 'COMPLETE');
    expect(store.getRun(run.id).state).toBe('COMPLETE');
  });

  it('enforces the repair budget', () => {
    const { store } = makeStore();
    const run = newRun(store, { repairBudget: 1 });
    toRunning(store, run.id);
    advance(store, run.id, 'VERIFYING', 'REPAIRING', 'RUNNING', 'VERIFYING');
    expect(code(() => store.transition(run.id, 'REPAIRING', { actor: 'a' }))).toBe('PL_STATE_030');
    advance(store, run.id, 'BLOCKED');
    expect(store.getRun(run.id).blockedReason).toBe('unspecified');
  });
});

describe('durability, idempotency and audit', () => {
  it('survives a process restart and keeps state', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pl-')), 'state.db');
    const a = makeStore(path);
    const run = newRun(a.store);
    advance(a.store, run.id, 'DISCOVERING');
    a.store.db.close();
    const b = makeStore(path);
    expect(b.store.getRun(run.id).state).toBe('DISCOVERING');
  });

  it('createRun with the same idempotency key returns the same run', () => {
    const { store } = makeStore();
    const a = newRun(store, { idempotencyKey: 'k1' });
    const b = newRun(store, { idempotencyKey: 'k1' });
    expect(b.id).toBe(a.id);
    expect(store.listRuns().length).toBe(1);
  });

  it('evidence, gate results and audit events are append-only', () => {
    const { store } = makeStore();
    const run = newRun(store);
    toRunning(store, run.id);
    gate(store, run.id, 'PASS');
    const evd = store.addEvidence({ taskRunId: run.id, kind: 'log', uri: 'x', checksum: 'c', environment: 'test', summary: 's', redactionStatus: 'redacted' });
    expect(() => store.db.exec(`UPDATE gate_result SET state = 'PASS'`)).toThrow(/append-only/);
    expect(() => store.db.exec(`DELETE FROM evidence_artifact WHERE id = '${evd}'`)).toThrow(/append-only/);
    expect(() => store.db.exec('DELETE FROM event')).toThrow(/append-only/);
  });

  it('redacts secrets in audit data', () => {
    const { store } = makeStore();
    const run = newRun(store);
    store.audit(run.id, 'x', 'a', { note: `token ${FAKE_GH_TOKEN}` });
    expect(JSON.stringify(store.events(run.id, 'x'))).not.toContain('ghp_abc');
  });

  it('marks running steps interrupted and numbers retry attempts', () => {
    const { store } = makeStore();
    const run = newRun(store);
    const s1 = store.beginStep(run.id, 'implement');
    expect(s1.attempt).toBe(1);
    expect(store.interruptRunningSteps(run.id)).toBe(1);
    expect(store.beginStep(run.id, 'implement').attempt).toBe(2);
    expect(store.stepDone(run.id, 'implement')).toBe(false);
  });
});

describe('worker leases', () => {
  it('does not grant duplicate ownership and fences stale holders after expiry', () => {
    const { store, clock } = makeStore();
    const run = newRun(store);
    const l1 = store.acquireLease(run.id, 'n1', 'w1', 1000)!;
    expect(store.acquireLease(run.id, 'n1', 'w2', 1000)).toBeNull();
    expect(store.heartbeatLease(run.id, 'n1', 'w1', l1.generation, 1000)).toBe(true);
    clock.advance(2000);
    expect(store.expiredLeases(run.id).map((l) => l.taskNodeId)).toEqual(['n1']);
    const l2 = store.acquireLease(run.id, 'n1', 'w2', 1000)!;
    expect(l2.generation).toBe(l1.generation + 1);
    expect(store.heartbeatLease(run.id, 'n1', 'w1', l1.generation, 1000)).toBe(false);
  });
});
