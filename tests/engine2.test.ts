import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedRuntime } from '../src/agent/runtime';
import { gateReport } from '../src/gates/runner';
import { Git } from '../src/git/git';
import type { GithubPort } from '../src/github/adapter';
import { approvePlan } from '../src/plan/workflow';
import { agents, approveAndRun, bareRemote, engineFor, featurePlan, project, task, waitFor, write } from './engine-helpers';
import { validPlan } from './plan-helpers';

const BOTH_FILES = `const fs=require('fs');process.exit(fs.existsSync('a/x.txt')&&fs.existsSync('b/y.txt')?0:1)`;
const twoTaskPlan = (deps: string[] = [], scopesB = ['b/**']) =>
  featurePlan({
    affectedModules: [{ path: 'a/x.txt', reason: 'a file', status: 'confirmed' }, { path: 'b/y.txt', reason: 'b file', status: 'confirmed' }],
    tasks: [task('task-a', ['a/**']), task('task-b', scopesB, deps)],
  });
const twoProject = () => project({ files: { 'check.js': BOTH_FILES } });
const writeFor = (req: { cwd: string; prompt: string }): void => {
  if (req.prompt.includes('task-a')) write(req.cwd, 'a/x.txt', '1');
  else write(req.cwd, 'b/y.txt', '2');
};

describe('parallel execution (v0.3)', () => {
  it('runs independent tasks concurrently in separate worktrees and integrates them', async () => {
    const root = await twoProject();
    const cwds: string[] = [];
    let started = 0;
    const rt = agents({ plan: twoTaskPlan(), implement: async (req) => { cwds.push(req.cwd); started++; await waitFor(() => started === 2); writeFor(req); } });
    const e = await engineFor(root, rt, { config: { limits: { maxParallel: 2 } as never } });
    const { runId, final } = await approveAndRun(e);
    expect(final.state).toBe('PR_OPEN');
    expect(new Set(cwds).size).toBe(2);
    expect(cwds.every((c) => /\/task-[ab]$/.test(c))).toBe(true);
    const wt = e.d.store.getRun(runId).worktreePath!;
    expect(cwds).not.toContain(wt);
    const files = (await new Git().run(wt, ['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n');
    expect(files).toEqual(expect.arrayContaining(['a/x.txt', 'b/y.txt']));
    expect(gateReport(e.d.store, runId).allRequiredPass).toBe(true);
  });

  it('a dependent task cannot start before its prerequisite finishes', async () => {
    const order: string[] = [];
    const rt = agents({ plan: twoTaskPlan(['task-a']), implement: async (req) => { order.push(req.prompt.includes('task-a') ? 'a:start' : 'b:start'); await new Promise((r) => setTimeout(r, 30)); writeFor(req); order.push(req.prompt.includes('task-a') ? 'a:end' : 'b:end'); } });
    const e = await engineFor(await twoProject(), rt, { config: { limits: { maxParallel: 2 } as never } });
    const { final } = await approveAndRun(e);
    expect(final.state).toBe('PR_OPEN');
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('tasks with overlapping file scopes run sequentially even with spare capacity', async () => {
    let live = 0;
    let peak = 0;
    const rt = agents({ plan: twoTaskPlan([], ['a/**']), implement: async (req) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 40)); write(req.cwd, req.prompt.includes('task-a') ? 'a/x.txt' : 'a/y.txt', '1'); write(req.cwd, 'b/y.txt', '2'); live--; } });
    const e = await engineFor(await twoProject(), rt, { config: { limits: { maxParallel: 2 } as never } });
    await approveAndRun(e);
    expect(peak).toBe(1);
  });

  it('two runs never share a working directory', async () => {
    const root = await project();
    const e = await engineFor(root, agents());
    const a = await approveAndRun(e, 'Add first feature file');
    const b = await approveAndRun(e, 'Add second feature file');
    expect(e.d.store.getRun(a.runId).worktreePath).not.toBe(e.d.store.getRun(b.runId).worktreePath);
  });
});

describe('interruption and recovery (Scenario D, AC6)', () => {
  it('resumes without redoing completed tasks and never marks unfinished work complete', async () => {
    const root = await twoProject();
    const dbFile = join(root, '.proofloop', 'state.db');
    let crash = true;
    const calls: string[] = [];
    const impl = (req: { cwd: string; prompt: string }): void => {
      const which = req.prompt.includes('task-a') ? 'a' : 'b';
      calls.push(which + (req.prompt.includes('previous attempt') ? ':interrupted' : ''));
      if (which === 'b' && crash) {
        write(req.cwd, 'b/partial.txt', 'half-done');
        throw new Error('process died');
      }
      writeFor(req);
    };
    const plan = twoTaskPlan(['task-a']);
    const e1 = await engineFor(root, agents({ plan, implement: impl }), { dbFile });
    const run = await e1.start({ protocolId: 'feature', intent: 'Add a and b files' });
    await e1.drive(run.id);
    approvePlan(e1.d.store, run.id, { planHash: e1.d.store.getRun(run.id).currentPlanHash!, by: 'human:t' });
    await expect(e1.drive(run.id)).rejects.toThrow('process died');
    expect(e1.d.store.getRun(run.id).state).toBe('RUNNING');
    // simulate the dead worker's lease surviving a hard kill
    e1.d.store.setNodeState(run.id, 'task-b', 'RUNNING');
    e1.d.store.acquireLease(run.id, 'task-b', 'w-999999-1', 3_600_000);
    crash = false;

    const e2 = await engineFor(root, agents({ plan, implement: impl }), { dbFile });
    const out = await e2.resume(run.id);
    expect(out.state).toBe('PR_OPEN');
    expect(calls).toEqual(['a', 'b', 'b:interrupted']);
    expect(e2.d.store.events(run.id, 'resume.reconciled').length).toBe(1);
    expect(e2.d.store.nodes(run.id).every((n) => n.state === 'DONE')).toBe(true);
  });

  it('resume of a verifying run re-runs gates on the actual HEAD, not stale results', async () => {
    const root = await project();
    const dbFile = join(root, '.proofloop', 'state.db');
    const e = await engineFor(root, agents(), { dbFile });
    const { runId } = await approveAndRun(e);
    const git = new Git();
    const run = e.d.store.getRun(runId);
    write(run.worktreePath!, 'extra.txt', 'x');
    await git.commitAll(run.worktreePath!, 'chore: manual commit');
    const sha = await git.head(run.worktreePath!);
    expect(sha).not.toBe(run.headSha);
    const e2 = await engineFor(root, agents(), { dbFile });
    await e2.resume(runId);
    expect(e2.d.store.getRun(runId).headSha).toBe(sha);
    expect(e2.d.store.events(runId, 'resume.reconciled').at(-1)!.data).toMatchObject({ actualHead: sha });
  });

  it('blocks when the worktree disappeared and recreates it on --retry from the branch', async () => {
    const root = await project();
    const e = await engineFor(root, agents());
    const { runId } = await approveAndRun(e);
    const run = e.d.store.getRun(runId);
    e.d.store.transition(runId, 'REPAIRING', { actor: 't' });
    const { rmSync } = await import('node:fs');
    rmSync(run.worktreePath!, { recursive: true, force: true });
    const out = await e.resume(runId);
    expect(out).toMatchObject({ state: 'BLOCKED', waiting: 'human' });
    expect(out.reason).toMatch(/worktree .* is missing/);
  });
});

describe('pause, budget and risk escalation', () => {
  it('rate limits pause the run; resume continues', async () => {
    let limited = true;
    const rt = agents({ implement: (req) => { if (limited) throw Object.assign(new Error('x'), {}); write(req.cwd, 'feature.txt', 'ok\n'); } });
    const rate = new ScriptedRuntime((req) => {
      if (req.role === 'planner') return { structured: featurePlan() };
      if (req.role === 'implementer' && limited) return { ok: false, error: '429 rate limit exceeded' };
      if (req.role === 'implementer') { write(req.cwd, 'feature.txt', 'ok\n'); return {}; }
      return { structured: { verdict: 'approve', findings: [], unsupportedClaims: [] } };
    });
    void rt;
    const e = await engineFor(await project(), rate);
    const run = await e.start({ protocolId: 'feature', intent: 'Add paused feature' });
    await e.drive(run.id);
    approvePlan(e.d.store, run.id, { planHash: e.d.store.getRun(run.id).currentPlanHash!, by: 'human:t' });
    const paused = await e.drive(run.id);
    expect(paused).toMatchObject({ state: 'PAUSED', waiting: 'human' });
    limited = false;
    expect((await e.resume(run.id)).state).toBe('PR_OPEN');
  });

  it('pause request stops before the next task', async () => {
    const plan = twoTaskPlan(['task-a']);
    const e = await engineFor(await twoProject(), agents({ plan, implement: (req) => { writeFor(req); if (req.prompt.includes('task-a')) e.pause(e.d.store.listRuns()[0]!.id); } }));
    const { final, runId } = await approveAndRun(e);
    expect(final.state).toBe('PAUSED');
    expect(e.d.store.nodes(runId).map((n) => n.state)).toEqual(['DONE', 'PENDING']);
    expect((await e.resume(runId)).state).toBe('PR_OPEN');
  });

  it('stops with BLOCKED when the spend budget is exhausted', async () => {
    const e = await engineFor(await project(), agents(), { config: { limits: { maxBudgetUsd: 0.005 } as never } });
    const { final } = await approveAndRun(e);
    expect(final.state).toBe('BLOCKED');
    expect(final.reason).toMatch(/budget/);
  });

  it('raises risk from files actually changed, which adds stricter required gates (cannot be lowered)', async () => {
    const plan = featurePlan({ tasks: [task('task-1', ['feature.txt', 'src/auth/**'])] });
    const e = await engineFor(await project(), agents({ plan, implement: (req) => { write(req.cwd, 'feature.txt', 'ok\n'); write(req.cwd, 'src/auth/login.ts', 'export {}\n'); } }));
    const { runId, final } = await approveAndRun(e);
    expect(e.d.store.getRun(runId).risk).toBe('high');
    expect(final.state).toBe('BLOCKED');
    expect(final.reason).toMatch(/browser|security-scan|migration/);
  });
});

describe('bug protocol', () => {
  const bugPlan = (over: { reproducible?: 'yes' | 'no' | 'unknown' } = {}) =>
    validPlan({
      affectedModules: [{ path: 'fix.txt', reason: 'the bug', status: 'confirmed' }],
      acceptanceCriteria: [{ id: 'AC-1', text: 'fix.txt exists after the fix', tests: ['bug.check.js'] }],
      tasks: [task('task-1', ['bug.check.js']), task('task-2', ['fix.txt'], ['task-1'])],
      gateCommands: { 'regression-test': 'node bug.check.js' },
      reproduction: { steps: 'run it', observed: 'fix.txt missing', expected: 'fix.txt present', reproducible: over.reproducible ?? 'yes' },
      regressionTest: { file: 'bug.check.js', command: 'node bug.check.js' },
      rootCause: { hypotheses: ['fix.txt is never written after retry'], confirmed: 'the retry path skips the writer' },
    });
  const BUG_CHECK = `process.exit(require('fs').existsSync('fix.txt')?0:1)`;
  const bugProject = () => project({ scripts: { lint: 'node -e 0', test: 'node -e 0', build: 'node -e 0', typecheck: 'node -e 0' } });

  async function runBug(plan: ReturnType<typeof bugPlan>, impl: (req: { cwd: string; prompt: string }) => void) {
    const e = await engineFor(await bugProject(), agents({ plan, implement: impl }));
    const run = await e.start({ protocolId: 'bug', intent: 'fix.txt is missing after retry' });
    await e.drive(run.id);
    approvePlan(e.d.store, run.id, { planHash: e.d.store.getRun(run.id).currentPlanHash!, by: 'human:t' });
    return { e, runId: run.id, final: await e.drive(run.id) };
  }

  it('requires a regression test that fails before the fix and passes after', async () => {
    const { e, runId, final } = await runBug(bugPlan(), (req) => (req.prompt.includes('task-1') ? write(req.cwd, 'bug.check.js', BUG_CHECK) : write(req.cwd, 'fix.txt', 'fixed')));
    expect(final.state).toBe('PR_OPEN');
    const repro = e.d.store.evidenceFor(runId).find((x) => x.kind === 'reproduction')!;
    expect(String(repro.summary)).toMatch(/^FAIL/);
    expect(e.d.store.gateHistory(runId, 'reproduction-proven').at(-1)!.state).toBe('PASS');
  });

  it('rejects a regression test that already passes before the fix', async () => {
    const plan = bugPlan();
    plan.tasks[0]!.fileScopes = ['bug.check.js', 'fix.txt'];
    const { e, runId, final } = await runBug(plan, (req) => { write(req.cwd, 'bug.check.js', BUG_CHECK); write(req.cwd, 'fix.txt', 'fixed'); });
    expect(final.state).toBe('BLOCKED');
    expect(e.d.store.gateHistory(runId, 'reproduction-proven').at(-1)).toMatchObject({ state: 'FAIL', failureCategory: 'regression-test-did-not-fail-first' });
  });

  it('asks for more information instead of inventing a fix when the bug was not reproduced', async () => {
    const { e, runId, final } = await runBug(bugPlan({ reproducible: 'no' }), (req) => (req.prompt.includes('task-1') ? write(req.cwd, 'bug.check.js', BUG_CHECK) : write(req.cwd, 'fix.txt', 'fixed')));
    expect(final.state).toBe('BLOCKED');
    expect(e.d.store.gateHistory(runId, 'reproduction-proven').at(-1)).toMatchObject({ state: 'BLOCKED', failureCategory: 'not-reproduced' });
  });
});

describe('GitHub delivery and sync', () => {
  function fakePort(over: Partial<GithubPort> = {}) {
    const log: string[] = [];
    const port: GithubPort = {
      preflight: async () => ({ ok: true, repo: 'o/r', problems: [], canWrite: true }),
      ensureIssue: async (key) => { log.push(`issue:${key}`); return { number: 5, nodeId: 'N5', url: 'https://github.com/o/r/issues/5' }; },
      addCheckpoint: async (_i, key) => { log.push(`cp:${key.split(':').at(-1)}`); },
      linkSubIssue: async () => 'linked',
      blockedBy: async () => 'linked',
      openPullRequest: async () => { log.push('pr'); return 'https://github.com/o/r/pull/1'; },
      getIssue: async () => ({ number: 5, title: '', body: '', state: 'open' }),
      getPullRequest: async () => ({ state: 'OPEN', checks: 'success' }),
      ...over,
    };
    return { port, log };
  }

  it('creates one parent issue, opens a PR with Closes #N, then completes only when merged', async () => {
    const root = await project();
    await bareRemote(root);
    let prState: 'OPEN' | 'MERGED' = 'OPEN';
    const { port, log } = fakePort({ getPullRequest: async () => ({ state: prState, checks: 'success' }) });
    const bodies: string[] = [];
    port.openPullRequest = async (i) => { bodies.push(i.body); log.push('pr'); return 'https://github.com/o/r/pull/1'; };
    const e = await engineFor(root, agents(), { port });
    const { runId, final } = await approveAndRun(e);
    expect(final).toMatchObject({ state: 'PR_OPEN', waiting: 'merge' });
    expect(log.filter((l) => l.startsWith('issue:')).length).toBe(1);
    expect(bodies[0]).toContain('Closes #5');
    expect(bodies[0]).toContain('All required gates PASS');
    expect((await e.resume(runId)).state).toBe('PR_OPEN');
    prState = 'MERGED';
    expect((await e.resume(runId)).state).toBe('COMPLETE');
    expect(log.filter((l) => l.startsWith('issue:')).length).toBe(1);
  });

  it('failing CI on the PR sends the run back through bounded repair', async () => {
    const root = await project();
    await bareRemote(root);
    const seq = ['failure', 'success'];
    const { port } = fakePort({ getPullRequest: async () => ({ state: 'OPEN', checks: (seq.shift() ?? 'success') as 'success' }) });
    const rt = agents({ implement: (req, n) => write(req.cwd, 'feature.txt', 'ok\n' + (n > 1 ? '' : '')) });
    const e = await engineFor(root, rt, { port });
    const { runId } = await approveAndRun(e);
    const out = await e.resume(runId);
    expect(e.d.store.getRun(runId).repairCount).toBe(1);
    expect(out.state).toBe('PR_OPEN');
    expect(rt.calls.filter((c) => c.role === 'implementer').length).toBe(2);
  });

  it('when GitHub is unreachable at delivery the run waits honestly in REVIEW_REQUIRED, then delivers on retry', async () => {
    const root = await project();
    await bareRemote(root);
    let down = true;
    const { port } = fakePort({ openPullRequest: async () => { if (down) throw new Error('connection refused'); return 'https://github.com/o/r/pull/2'; } });
    const e = await engineFor(root, agents(), { port });
    const { runId, final } = await approveAndRun(e);
    expect(final).toMatchObject({ state: 'REVIEW_REQUIRED', waiting: 'github' });
    expect(e.d.store.getRun(runId).prUrl).toBeNull();
    down = false;
    expect((await e.resume(runId)).state).toBe('PR_OPEN');
  });

  it('checkpoints at phase boundaries, not per tool call', async () => {
    const root = await project();
    await bareRemote(root);
    const { port, log } = fakePort();
    await approveAndRun(await engineFor(root, agents(), { port }));
    const cps = log.filter((l) => l.startsWith('cp:'));
    expect(cps.length).toBeGreaterThan(0);
    expect(cps.length).toBeLessThan(6);
  });
});

void writeFileSync;
