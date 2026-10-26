import { describe, expect, it } from 'vitest';
import { readyNodes, topoSort } from '../src/plan/dag';
import { validatePlan } from '../src/plan/schema';
import { approveGated, approvePlan, getPlan, rejectPlan, submitPlan } from '../src/plan/workflow';
import { isPlError } from '../src/shared/errors';
import { advance, makeStore, newRun } from './helpers';
import { validPlan } from './plan-helpers';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return isPlError(e) ? e.code : 'OTHER';
  }
};

describe('DAG', () => {
  it('orders dependencies and rejects cycles with the path', () => {
    const n = (id: string, d: string[] = []) => ({ id, dependencies: d });
    expect(topoSort([n('c', ['b']), n('b', ['a']), n('a')]).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(() => topoSort([n('a', ['b']), n('b', ['a'])])).toThrow(/cycle: a -> b -> a/);
    expect(() => topoSort([n('a', ['zzz'])])).toThrow(/unknown/);
    expect(readyNodes([n('a'), n('b', ['a'])], new Set(), new Set()).map((x) => x.id)).toEqual(['a']);
    expect(readyNodes([n('a'), n('b', ['a'])], new Set(['a']), new Set()).map((x) => x.id)).toEqual(['b']);
  });
});

describe('plan validation', () => {
  it('accepts a complete plan (AC3: intent, assumptions, modules, criteria, tests, risk)', () => {
    const v = validatePlan(validPlan());
    expect(v.errors).toEqual([]);
    expect(v.plan?.risk.level).toBe('medium');
  });

  it('rejects criteria with neither a test nor a documented manual check', () => {
    const v = validatePlan(validPlan({ acceptanceCriteria: [{ id: 'AC-1', text: 'Something works well', tests: [] }] }));
    expect(v.errors.join()).toContain('no executable test');
    expect(validatePlan(validPlan({ acceptanceCriteria: [{ id: 'AC-1', text: 'Something works well', tests: [], manual: { reason: 'visual check by designer' } }] })).errors).toEqual([]);
  });

  it('rejects uncovered criteria, unknown refs, duplicate ids and cycles', () => {
    const p = validPlan();
    expect(validatePlan({ ...p, acceptanceCriteria: [...p.acceptanceCriteria, { id: 'AC-2', text: 'Another thing here', tests: ['x'] }] }).errors.join()).toContain('AC-2 is not covered');
    expect(validatePlan({ ...p, tasks: [{ ...p.tasks[0]!, acceptanceCriteria: ['AC-9'] }] }).errors.join()).toContain('unknown criterion AC-9');
    expect(validatePlan({ ...p, tasks: [p.tasks[0]!, p.tasks[0]!] }).errors.join()).toContain('duplicate id');
    const two = [{ ...p.tasks[0]!, id: 'task-a', dependencies: ['task-b'] }, { ...p.tasks[0]!, id: 'task-b', dependencies: ['task-a'] }];
    expect(validatePlan({ ...p, tasks: two }).errors.join()).toContain('cycle');
  });

  it('cannot lower risk below the engine floor for sensitive paths: it is raised, not rejected', () => {
    const v = validatePlan(validPlan({ affectedModules: [{ path: 'src/auth/session.ts', reason: 'login', status: 'confirmed' }], risk: { level: 'low', rationale: 'tiny change' } }));
    expect(v.errors).toEqual([]);
    expect(v.effectiveRisk).toBe('high');
    expect(v.plan?.risk.level).toBe('high');
    expect(v.warnings.join()).toContain('risk raised from "low" to "high"');
  });

  it('requires reproduction and regression test for bug plans', () => {
    expect(validatePlan(validPlan(), { protocolId: 'bug' }).errors.length).toBe(3);
  });

  it('warns about overlapping unordered tasks and hypotheses, errors on unknown keys', () => {
    const p = validPlan();
    const t2 = { ...p.tasks[0]!, id: 'task-2' };
    const v = validatePlan({ ...p, tasks: [p.tasks[0]!, t2], affectedModules: [{ path: 'src/x.ts', reason: 'maybe here', status: 'hypothesis' }] });
    expect(v.warnings.join()).toContain('overlap');
    expect(v.warnings.join()).toContain('hypothesis');
    expect(validatePlan({ ...p, extra: 1 }).errors.join()).toContain('Unrecognized');
  });
});

describe('plan approval workflow', () => {
  function planning() {
    const { store } = makeStore();
    const run = newRun(store);
    advance(store, run.id, 'DISCOVERING', 'PLANNING');
    return { store, id: run.id };
  }

  it('submit -> approve -> ready; approvals bind to the plan hash (AC2)', () => {
    const { store, id } = planning();
    const sub = submitPlan(store, id, validPlan());
    expect(sub.run.state).toBe('AWAITING_APPROVAL');
    expect(sub.markdown).toContain('Acceptance criteria');
    expect(store.nodes(id).length).toBe(1);
    expect(codeOf(() => approvePlan(store, id, { planHash: 'wrong', by: 'human:me' }))).toBe('PL_PLAN_003');
    expect(approvePlan(store, id, { planHash: sub.hash, by: 'human:me' }).state).toBe('APPROVED');
    advance(store, id, 'READY');
    expect(getPlan(store, id).intent.summary).toContain('pagination');
  });

  it('an agent cannot approve its own plan', () => {
    const { store, id } = planning();
    const sub = submitPlan(store, id, validPlan());
    expect(codeOf(() => approvePlan(store, id, { planHash: sub.hash, by: 'agent:planner' }))).toBe('PL_APPROVAL_001');
    expect(store.getRun(id).state).toBe('AWAITING_APPROVAL');
    expect(store.events(id, 'approval.refused').length).toBe(1);
  });

  it('invalid plans change nothing and are audited', () => {
    const { store, id } = planning();
    expect(codeOf(() => submitPlan(store, id, { nope: true }))).toBe('PL_PLAN_010');
    expect(store.getRun(id)).toMatchObject({ state: 'PLANNING', planVersion: 0 });
    expect(store.events(id, 'plan.invalid').length).toBe(1);
  });

  it('reject sends the run back to PLANNING and an edited plan needs fresh approval', () => {
    const { store, id } = planning();
    const a = submitPlan(store, id, validPlan());
    expect(rejectPlan(store, id, { by: 'human:me', comment: 'scope too big' }).state).toBe('PLANNING');
    const b = submitPlan(store, id, validPlan({ intent: { summary: 'Smaller pagination scope', outcome: 'Users page shows 20 per page', constraints: [], nonGoals: [] } }));
    expect(b.hash).not.toBe(a.hash);
    expect(b.version).toBe(2);
    expect(codeOf(() => approvePlan(store, id, { planHash: a.hash, by: 'human:me' }))).toBe('PL_PLAN_003');
    expect(approvePlan(store, id, { planHash: b.hash, by: 'human:me' }).approvedPlanHash).toBe(b.hash);
  });

  it('resubmitting an identical plan is a no-op (idempotent)', () => {
    const { store, id } = planning();
    const a = submitPlan(store, id, validPlan());
    const b = submitPlan(store, id, validPlan());
    expect(b.hash).toBe(a.hash);
    expect(b.version).toBe(1);
  });

  it('engine raises risk from paths even if the plan claims less, and gated approvals need a human', () => {
    const { store, id } = planning();
    submitPlan(store, id, validPlan({ risk: { level: 'high', rationale: 'sensitive' }, affectedModules: [{ path: 'db/migrations/1.sql', reason: 'schema', status: 'confirmed' }] }));
    expect(store.getRun(id).risk).toBe('high');
    expect(codeOf(() => approveGated(store, id, 'critical:rm -rf x', 'agent:impl'))).toBe('PL_APPROVAL_001');
    approveGated(store, id, 'critical:rm -rf x', 'human:me');
    expect(store.hasGatedApproval(id, 'critical:rm -rf x')).toBe(true);
    expect(store.hasGatedApproval(id, 'critical:other')).toBe(false);
  });
});
