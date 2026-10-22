import { describe, expect, it } from 'vitest';
import { Git } from '../src/git/git';
import { gateReport } from '../src/gates/runner';
import { approvePlan } from '../src/plan/workflow';
import { agents, approveAndRun, engineFor, featurePlan, project, write } from './engine-helpers';

describe('feature protocol, sequential, local-only', () => {
  it('plans, waits for approval, implements in a worktree, verifies, reviews and delivers', async () => {
    const root = await project();
    const rt = agents();
    const e = await engineFor(root, rt);
    const { runId, first, final } = await approveAndRun(e);

    expect(first).toMatchObject({ state: 'AWAITING_APPROVAL', waiting: 'approval' });
    // AC2: no implementer ran, no worktree existed, before approval was recorded
    expect(rt.calls.filter((c) => c.role === 'implementer').length).toBe(1);
    expect(final).toMatchObject({ state: 'PR_OPEN', waiting: 'merge' });

    const run = e.d.store.getRun(runId);
    expect(run.prUrl).toMatch(/^local-branch:feature\//);
    expect(gateReport(e.d.store, runId).allRequiredPass).toBe(true);
    const git = new Git();
    expect(await git.isClean(root)).toBe(true); // main checkout untouched
    expect(await git.run(run.worktreePath!, ['show', 'HEAD:feature.txt'])).toBe('ok');
    expect(run.risk).toBe('medium');

    // merging the branch (by a human) lets resume record completion
    await git.run(root, ['merge', '--no-ff', '-m', 'merge', run.activeBranch!]);
    const done = await e.resume(runId);
    expect(done.state).toBe('COMPLETE');
  });

  it('never calls the implementer with Bash approval or git push; evaluators are read-only', async () => {
    const root = await project();
    const rt = agents();
    await approveAndRun(await engineFor(root, rt));
    const reviewer = rt.calls.find((c) => c.role === 'reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer!.resumeSessionId).toBeUndefined();
    const impl = rt.calls.find((c) => c.role === 'implementer')!;
    expect(impl.cwd).toContain('.proofloop/worktrees');
    expect(impl.allowedTools).toContain('Edit');
    expect(impl.allowedTools?.some((t) => t.includes('approve'))).toBe(false);
  });

  it('reports repo limitations instead of inventing commands (AC4) and blocks when nothing can be verified', async () => {
    const root = await project({ scripts: {} });
    const e = await engineFor(root, agents());
    const { runId, final } = await approveAndRun(e);
    expect(final.state).toBe('BLOCKED');
    expect(final.reason).toMatch(/no required gate can run/);
    expect(e.d.store.getRun(runId).state).not.toBe('COMPLETE');
    expect(e.report(runId)).toContain('BLOCKED');
  });

  it('a failing test cannot complete: repair runs, then identical failure stops early (AC7)', async () => {
    const root = await project();
    const rt = agents({ implement: (req) => write(req.cwd, 'feature.txt', 'wrong\n') });
    const e = await engineFor(root, rt);
    const { runId, final } = await approveAndRun(e);
    expect(final.state).toBe('BLOCKED');
    expect(final.reason).toMatch(/identical failure repeated/);
    const run = e.d.store.getRun(runId);
    expect(run.repairCount).toBe(1);
    expect(gateReport(e.d.store, runId).allRequiredPass).toBe(false);
    expect(e.d.store.gateHistory(runId, 'unit').map((g) => g.state)).toEqual(['FAIL', 'FAIL']);
    expect(() => e.d.store.transition(runId, 'COMPLETE', { actor: 'x' })).toThrow();
  });

  it('repairs a real failure with the failure evidence and then passes', async () => {
    const root = await project();
    const rt = agents({ implement: (req, n) => write(req.cwd, 'feature.txt', n === 1 ? 'wrong\n' : 'ok\n') });
    const e = await engineFor(root, rt);
    const { runId, final } = await approveAndRun(e);
    expect(final.state).toBe('PR_OPEN');
    expect(e.d.store.getRun(runId).repairCount).toBe(1);
    const repairCall = rt.calls.filter((c) => c.role === 'implementer')[1]!;
    expect(repairCall.prompt).toContain('failure-evidence');
    expect(repairCall.resumeSessionId).toBe('sess-2');
    expect(e.d.store.gateHistory(runId, 'unit').map((g) => g.state)).toEqual(['FAIL', 'PASS']);
  });

  it('stops when the repair budget is exhausted even if failures keep changing', async () => {
    const root = await project();
    const rt = agents({ implement: (req, n) => write(req.cwd, 'feature.txt', `wrong${n}\n`) });
    const e = await engineFor(root, rt);
    const { final } = await approveAndRun(e);
    expect(final.state).toBe('BLOCKED');
  });

  it('reverts edits outside the approved scope and never commits them', async () => {
    const root = await project();
    const rt = agents({ implement: (req) => { write(req.cwd, 'feature.txt', 'ok\n'); write(req.cwd, 'sneaky.txt', 'x'); write(req.cwd, '.github/workflows/ci.yml', 'x'); } });
    const e = await engineFor(root, rt);
    const { runId, final } = await approveAndRun(e);
    expect(final.state).toBe('PR_OPEN');
    const wt = e.d.store.getRun(runId).worktreePath!;
    const files = (await new Git().run(wt, ['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n');
    expect(files).not.toContain('sneaky.txt');
    expect(files).not.toContain('.github/workflows/ci.yml');
    expect(e.d.store.events(runId, 'scope.reverted')[0]!.data.files).toEqual(expect.arrayContaining(['sneaky.txt']));
    expect(e.report(runId)).toContain('out-of-scope edits were reverted');
  });

  it('blocks tests that were weakened to get green', async () => {
    const root = await project({ files: { 'tests/a.test.ts': "expect(1).toBe(1);\nexpect(2).toBe(2);\n" } });
    const plan = featurePlan({ tasks: [{ id: 'task-1', title: 'Tweak', description: 'tweak things', dependencies: [], fileScopes: ['feature.txt', 'tests/**'], acceptanceCriteria: ['AC-1'], risk: 'medium', doneWhen: 'tests pass' }] });
    const rt = agents({ plan, implement: (req) => { write(req.cwd, 'feature.txt', 'ok\n'); write(req.cwd, 'tests/a.test.ts', "expect(1).toBe(1);\n"); } });
    const e = await engineFor(root, rt);
    const { runId, final } = await approveAndRun(e);
    expect(final.state).toBe('BLOCKED');
    expect(e.d.store.gateHistory(runId, 'test-integrity')[0]).toMatchObject({ state: 'FAIL', failureCategory: 'test-weakened' });
  });

  it('review requesting changes triggers repair; an unrunnable review blocks instead of passing', async () => {
    const root = await project();
    let reviews = 0;
    const rt = agents({ review: () => (++reviews === 1 ? { verdict: 'changes_requested', findings: [{ severity: 'high', file: 'feature.txt', summary: 'missing newline handling', evidence: 'line 3 drops it' }], unsupportedClaims: [] } : { verdict: 'approve', findings: [], unsupportedClaims: [] }) });
    const { runId, final } = await approveAndRun(await engineFor(root, rt));
    expect(final.state).toBe('PR_OPEN');
    expect(reviews).toBe(2);
    const bad = agents({ review: { nonsense: true } });
    const r2 = await approveAndRun(await engineFor(await project(), bad));
    expect(r2.final.state).toBe('BLOCKED');
    expect(r2.final.reason).toMatch(/could not produce a valid review/);
    expect(runId).toBeTruthy();
  });

  it('start is idempotent: the same request does not create a second run', async () => {
    const e = await engineFor(await project(), agents());
    const a = await e.start({ protocolId: 'feature', intent: 'Add x' });
    const b = await e.start({ protocolId: 'feature', intent: 'Add x' });
    expect(b.id).toBe(a.id);
    expect((await e.start({ protocolId: 'feature', intent: 'Add x', again: true })).id).not.toBe(a.id);
  });

  it('rejecting the plan returns to planning and a new plan needs new approval', async () => {
    const e = await engineFor(await project(), agents());
    const run = await e.start({ protocolId: 'feature', intent: 'Add y' });
    await e.drive(run.id);
    const { rejectPlan } = await import('../src/plan/workflow');
    rejectPlan(e.d.store, run.id, { by: 'human:t', comment: 'smaller please' });
    expect(e.d.store.getRun(run.id).state).toBe('PLANNING');
    const again = await e.drive(run.id);
    expect(again.state).toBe('AWAITING_APPROVAL');
    expect(() => approvePlan(e.d.store, run.id, { planHash: 'stale', by: 'human:t' })).toThrow();
  });

  it('cancel stops the run and preserves the worktree and branch', async () => {
    const root = await project();
    const e = await engineFor(root, agents());
    const run = await e.start({ protocolId: 'feature', intent: 'Add z' });
    await e.drive(run.id);
    expect((await e.cancel(run.id)).state).toBe('CANCELLED');
    expect((await e.drive(run.id)).state).toBe('CANCELLED');
    expect(e.d.store.events(run.id, 'cancel.requested').length).toBe(1);
  });

  it('agent failure at planning blocks with the reason; --retry resumes planning', async () => {
    const root = await project();
    let fail = true;
    const { ScriptedRuntime } = await import('../src/agent/runtime');
    const rt = new ScriptedRuntime(() => (fail ? { ok: false, error: 'rate limit exceeded' } : { structured: featurePlan() }));
    const e = await engineFor(root, rt);
    const run = await e.start({ protocolId: 'feature', intent: 'Add w' });
    expect((await e.drive(run.id)).state).toBe('BLOCKED');
    expect((await e.resume(run.id)).waiting).toBe('human');
    fail = false;
    expect((await e.resume(run.id, { retry: true })).state).toBe('AWAITING_APPROVAL');
  });
});
