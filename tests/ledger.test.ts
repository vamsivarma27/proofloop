import { describe, expect, it } from 'vitest';
import { ScriptedRuntime } from '../src/agent/runtime';
import { createEngine } from '../src/engine/factory';
import { ledgerFor } from '../src/engine/ledger-io';
import { incidentsOf, repositoryIdOf, stepMemory, storedMemory } from '../src/engine/memory';
import type { GithubPort } from '../src/github/adapter';
import { buildLedger, renderLedgerMarkdown, renderLedgerSummary } from '../src/ledger/ledger';
import { approvePlan } from '../src/plan/workflow';
import { configSchema } from '../src/config';
import { runCli, type CliEnv } from '../src/cli/index';
import { bareRemote, engineFor, featurePlan, project, task, write } from './engine-helpers';
import { FAKE_GH_TOKEN } from './fake-secrets';
import { advance, gate, makeStore, newRun } from './helpers';
import { validPlan } from './plan-helpers';

const BUG_CHECK = `const fs=require('fs');process.exit(fs.existsSync('fix.txt')&&fs.readFileSync('fix.txt','utf8')==='fixed'?0:1)`;
const bugPlan = () =>
  validPlan({
    affectedModules: [{ path: 'fix.txt', reason: 'the bug', status: 'confirmed' }],
    acceptanceCriteria: [{ id: 'AC-1', text: 'fix.txt contains fixed after the fix', tests: ['bug.check.js'] }],
    tasks: [task('task-1', ['bug.check.js']), task('task-2', ['fix.txt'], ['task-1'])],
    reproduction: { steps: 'run it', observed: 'fix.txt missing', expected: 'fix.txt fixed', reproducible: 'yes' },
    regressionTest: { file: 'bug.check.js', command: 'node bug.check.js' },
    rootCause: { hypotheses: ['the retry path never writes fix.txt'], confirmed: 'the retry path never writes fix.txt' },
  });
const bugProject = () => project({ scripts: { lint: 'node -e 0', test: 'node -e 0', build: 'node -e 0', typecheck: 'node -e 0' } });

function port(search: GithubPort['searchHistory'], log: string[] = []): GithubPort {
  return {
    preflight: async () => ({ ok: true, repo: 'o/r', problems: [], canWrite: true }),
    ensureIssue: async (key) => (log.push(`issue:${key}`), { number: 42, nodeId: 'N42', url: 'https://github.com/o/r/issues/42' }),
    addCheckpoint: async (_i, key, body) => void log.push(`cp:${key.split(':').at(-1)}:${body.slice(0, 20)}`),
    linkSubIssue: async () => 'linked', blockedBy: async () => 'linked',
    openPullRequest: async (i) => (log.push(`pr:${i.body.includes('Proof Ledger')}`), 'https://github.com/o/r/pull/9'),
    getIssue: async () => ({ number: 42, title: '', body: '', state: 'open' }),
    getPullRequest: async () => ({ state: 'OPEN', checks: 'success' }),
    ...(search ? { searchHistory: search } : {}),
  };
}

describe('V0.2 end to end: memory -> plan -> failed attempt -> repair -> ledger -> restart', () => {
  it('retrieves a past incident into planning, preserves the failed attempt, verifies the exact revision and rebuilds the ledger after a restart', async () => {
    const root = await bugProject();
    await bareRemote(root);
    const prompts: string[] = [];
    const rt = new ScriptedRuntime(async (req, n) => {
      if (req.role === 'planner') return (prompts.push(req.prompt), { structured: bugPlan() });
      if (req.role === 'implementer') {
        if (req.prompt.includes('task-1')) write(req.cwd, 'bug.check.js', BUG_CHECK);
        else write(req.cwd, 'fix.txt', req.prompt.includes('repair attempt') ? 'fixed' : 'wrong');
        return { text: `done ${n}`, costUsd: 0.01 };
      }
      return { structured: { verdict: 'approve', findings: [], unsupportedClaims: [] }, costUsd: 0.01 };
    });
    const log: string[] = [];
    const e = await engineFor(root, rt, { port: port(async () => [], log) });
    const prior = incidentsOf(e.d);
    const repoId = await repositoryIdOf(e.d);
    const old = prior.create({ repositoryId: repoId, title: 'fix.txt is missing after retry', summary: 'fix.txt is missing after a retry', symptoms: ['fix.txt is missing after retry'], baseRevision: 'oldrev' });
    prior.recordAttempt(old, { id: 'a1', description: 'recreate fix.txt on every start', outcome: 'FAILURE', failureReason: 'masked the retry bug' }, 'engine');
    prior.addRegressionTest(old, { name: 'bug.check.js', filePath: 'bug.check.js', lastResult: 'PASS' }, 'engine');

    const run = await e.start({ protocolId: 'bug', intent: 'fix.txt is missing after retry' });
    const first = await e.drive(run.id);
    expect(first.reason ?? '').toBe('plan awaits human approval');
    expect(first.state).toBe('AWAITING_APPROVAL');

    // RETRIEVING_MEMORY ran, was persisted, and reached the planner
    const mem = storedMemory(e.d, run.id)!;
    expect(mem.completeness).toBe('complete');
    expect(mem.relatedIncidents[0]).toMatchObject({ incidentId: old });
    expect(prompts[0]).toContain('Historical engineering memory');
    expect(prompts[0]).toContain('previously failed: recreate fix.txt on every start');
    const states = e.d.store.events(run.id, 'transition').map((t) => String(t.data.to));
    expect(states.indexOf('RETRIEVING_MEMORY')).toBeGreaterThan(states.indexOf('DISCOVERING'));
    expect(states.indexOf('RETRIEVING_MEMORY')).toBeLessThan(states.indexOf('PLANNING'));
    expect(e.d.store.events(run.id, 'memory.retrieved')).toHaveLength(1);

    approvePlan(e.d.store, run.id, { planHash: e.d.store.getRun(run.id).currentPlanHash!, by: 'human:tester' });
    const final = await e.drive(run.id);
    expect(final.state).toBe('PR_OPEN');
    const head = e.d.store.getRun(run.id).headSha!;

    const ledger = await ledgerFor(e.d, run.id);
    // the failed attempt is preserved with its diagnosis, and the success is on a different, exact revision
    const attempts = ledger.implementation.attempts;
    expect(attempts.map((a) => a.outcome)).toEqual(['FAILURE', 'SUCCESS']);
    expect(attempts[0]).toMatchObject({ failureReason: expect.stringContaining('regression-test=FAIL'), diagnosis: expect.any(String) });
    expect(attempts[1]!.commitSha).toBe(head);
    expect(attempts[0]!.commitSha).not.toBe(head);
    expect(ledger.verification.every((v) => /^[0-9a-f]{40}$/.test(v.testedCommit))).toBe(true);
    const failed = ledger.verification.find((v) => v.gateId === 'regression-test' && v.result === 'FAIL')!;
    expect(failed).toMatchObject({ testedCommit: attempts[0]!.commitSha, currentForHead: false });
    expect(ledger.verification.filter((v) => v.required && v.currentForHead && v.result === 'PASS').length).toBeGreaterThan(0);
    expect(ledger.investigation.incident).toMatchObject({ status: 'VERIFIED', relatedCommits: expect.arrayContaining([head]), regressionTests: [{ name: 'bug.check.js', lastResult: 'PASS', lastVerifiedRevision: head }] });
    expect(ledger.investigation.confirmedRootCause).toBe('the retry path never writes fix.txt'); // confirmed by reproduction evidence, not asserted
    expect(ledger.assessment).toMatchObject({ disposition: 'READY_FOR_REVIEW', failed: [], pullRequestUrl: 'https://github.com/o/r/pull/9' });
    expect(ledger.implementation.changedFiles).toEqual(expect.arrayContaining(['bug.check.js', 'fix.txt']));
    expect(log.some((l) => l.startsWith('pr:true'))).toBe(true);
    expect(log.some((l) => l.includes('ledger-delivered'))).toBe(true);

    // restart: a new process over the same state rebuilds an equivalent ledger and the markdown mentions the failure
    const e2 = await engineFor(root, rt, { port: port(async () => [], []) });
    const again = await ledgerFor(e2.d, run.id);
    expect(again).toEqual(ledger);
    const md = renderLedgerMarkdown(again);
    expect(md).toContain('Proof Ledger');
    expect(md).toContain('FAILURE');
    expect(md).toContain(head.slice(0, 8));
    expect(md).toContain('READY FOR REVIEW');
    expect(renderLedgerSummary(again)).toContain('READY FOR REVIEW');
  }, 120_000);

  it('exports the ledger through the CLI as JSON and Markdown', async () => {
    const root = await bugProject();
    const e = await engineFor(root, new ScriptedRuntime(async () => ({ structured: bugPlan() })));
    const run = await e.start({ protocolId: 'bug', intent: 'fix.txt is missing after retry' });
    await e.drive(run.id);
    const out: string[] = [];
    const env: CliEnv = { cwd: root, env: {}, makeRuntime: () => new ScriptedRuntime(async () => ({ structured: bugPlan() })), io: { out: (t) => void out.push(t), err: () => undefined, stdin: () => '', isTTY: false, confirm: () => true } };
    expect(await runCli(['ledger', 'export', run.id, '--format', 'json', '--root', root], env)).toBe(0);
    const json = JSON.parse(out.join(''));
    expect(json).toMatchObject({ schemaVersion: 1, task: { id: run.id, protocol: 'bug' } });
    out.length = 0;
    expect(await runCli(['ledger', 'export', run.id, '--format', 'markdown', '--root', root], env)).toBe(0);
    expect(out.join('')).toContain('# ProofLoop Proof Ledger');
    expect(await runCli(['ledger', 'export', run.id, '--format', 'xml', '--root', root], env)).toBe(2);
    out.length = 0;
    expect(await runCli(['memory', run.id, '--root', root], env)).toBe(0);
    expect(await runCli(['incident', 'list', '--root', root], env)).toBe(0);
    expect(out.join('')).toContain('INVESTIGATING');
    const incId = incidentsOf(e.d).forRun(run.id)!;
    expect(await runCli(['incident', 'confirm', incId, '--text', 'the retry path skips the writer', '--yes', '--root', root], env)).toBe(0);
    expect(incidentsOf(e.d).get(incId)!.confirmedRootCause).toBe('the retry path skips the writer');
    expect(await runCli(['incident', 'confirm', incId, '--text', 'x', '--yes', '--root', root], { ...env, env: { PROOFLOOP_AGENT_SESSION: '1' } })).toBe(3);
  }, 60_000);
});

describe('retrieval step: failures, retries and recovery', () => {
  const planner = () => new ScriptedRuntime(async () => ({ structured: bugPlan() }));

  it('continues with a recorded, honest "incomplete" result when GitHub is down, retrying first', async () => {
    let calls = 0;
    const e = await engineFor(await bugProject(), planner(), { port: port(async () => { calls++; throw new Error('network unreachable'); }), config: { memory: { requireComplete: false, retries: 2, maxResults: 5 } } });
    const run = await e.start({ protocolId: 'bug', intent: 'fix.txt is missing after retry and times out' });
    expect((await e.drive(run.id)).state).toBe('AWAITING_APPROVAL');
    expect(calls).toBe(3);
    expect(storedMemory(e.d, run.id)).toMatchObject({ completeness: 'partial' });
    expect(e.d.store.events(run.id, 'memory.retry')).toHaveLength(2);
    expect(e.d.store.events(run.id, 'memory.retrieved')[0]!.data.warnings).toEqual(expect.arrayContaining([expect.stringContaining('does not mean no related history')]));
  });

  it('blocks instead of planning blind when memory.requireComplete is set', async () => {
    const e = await engineFor(await bugProject(), planner(), { port: port(async () => { throw new Error('HTTP 429 rate limit'); }), config: { memory: { requireComplete: true, retries: 0, maxResults: 5 } } });
    const run = await e.start({ protocolId: 'bug', intent: 'fix.txt is missing after retry and times out' });
    const out = await e.drive(run.id);
    expect(out).toMatchObject({ state: 'BLOCKED' });
    expect(out.reason).toContain('requireComplete');
    expect(e.d.store.getRun(run.id).state).toBe('BLOCKED');
  });

  it('is idempotent: re-entering the step reuses the stored result and never duplicates the incident or the event', async () => {
    const e = await engineFor(await bugProject(), planner());
    const run = await e.start({ protocolId: 'bug', intent: 'fix.txt is missing after retry' });
    e.d.store.transition(run.id, 'RETRIEVING_MEMORY', { actor: 'engine' });
    await stepMemory(e.d, run.id);
    // a crash after retrieval but before the transition was observed: loop the state back and re-enter the step
    e.d.store.transition(run.id, 'BLOCKED', { actor: 't', reason: 'crash' });
    e.d.store.transition(run.id, 'RETRIEVING_MEMORY', { actor: 't' });
    await stepMemory(e.d, run.id);
    expect(e.d.store.events(run.id, 'memory.retrieved')).toHaveLength(1);
    expect(incidentsOf(e.d).list(await repositoryIdOf(e.d)).filter((i) => i.taskRunId === run.id)).toHaveLength(1);
    expect(e.d.store.getRun(run.id).state).toBe('PLANNING');
  });

  it('resumes a run interrupted during retrieval and finishes planning', async () => {
    const root = await bugProject();
    const e = await engineFor(root, planner());
    const run = await e.start({ protocolId: 'bug', intent: 'fix.txt is missing after retry' });
    e.d.store.transition(run.id, 'RETRIEVING_MEMORY', { actor: 'engine' });
    const step = e.d.store.beginStep(run.id, 'memory');
    expect(step.attempt).toBe(1);
    const e2 = await engineFor(root, planner());
    expect((await e2.resume(run.id)).state).toBe('AWAITING_APPROVAL');
    expect(storedMemory(e2.d, run.id)).not.toBeNull();
  });

  it('feature runs keep working and create no incident', async () => {
    const root = await project();
    const e = await engineFor(root, new ScriptedRuntime(async () => ({ structured: featurePlan() })));
    const run = await e.start({ protocolId: 'feature', intent: 'Add the feature file' });
    expect((await e.drive(run.id)).state).toBe('AWAITING_APPROVAL');
    expect(incidentsOf(e.d).forRun(run.id)).toBeNull();
    expect(storedMemory(e.d, run.id)).not.toBeNull();
  });

  it('old runs created before memory existed still plan (DISCOVERING -> PLANNING stays valid)', async () => {
    const { store } = makeStore();
    const run = newRun(store);
    advance(store, run.id, 'DISCOVERING', 'PLANNING');
    expect(store.getRun(run.id).state).toBe('PLANNING');
  });
});

describe('proof ledger integrity', () => {
  function runWithGates(plan: unknown = { v: 1 }) {
    const { store } = makeStore();
    const run = newRun(store);
    advance(store, run.id, 'DISCOVERING', 'PLANNING');
    store.recordPlan(run.id, plan, 'hash1');
    advance(store, run.id, 'AWAITING_APPROVAL');
    store.recordApproval(run.id, { scope: 'plan', planHash: 'hash1', approvedBy: 'human:test', decision: 'approve' });
    advance(store, run.id, 'APPROVED', 'READY', 'RUNNING');
    store.setGatePlan(run.id, [{ gateId: 'unit', kind: 'unit', required: true, command: 'pnpm test' }]);
    store.setFields(run.id, { headSha: 'abc123' });
    return { store, id: run.id };
  }

  it('never calls a task completed while a required criterion is unverified or the evidence is stale', () => {
    const { store, id } = runWithGates(validPlan({ acceptanceCriteria: [{ id: 'AC-1', text: 'works as designed', tests: ['t'] }] }));
    gate(store, id, 'PASS', 'oldsha');
    advance(store, id, 'VERIFYING');
    store.setFields(id, { headSha: 'newsha' });
    const l = buildLedger(store, id, { changedFiles: [] });
    expect(l.assessment.staleEvidence).toEqual(['unit@oldsha']);
    expect(l.acceptanceCriteria[0]).toMatchObject({ status: 'NOT_RUN', testedCommit: null });
    expect(l.assessment.disposition).not.toBe('COMPLETED');
    expect(l.verification[0]).toMatchObject({ testedCommit: 'oldsha', currentForHead: false });
    expect(l.assessment.remainingRisks.join(' ')).toContain('earlier commit');
  });

  it('reports missing evidence explicitly and a failing gate as a failed criterion', () => {
    const { store, id } = runWithGates(validPlan());
    gate(store, id, 'FAIL', 'abc123');
    const l = buildLedger(store, id);
    expect(l.acceptanceCriteria[0]!.status).toBe('FAIL');
    expect(l.assessment.failed).toEqual(['AC-1']);
    expect(l.assessment.missingEvidence).toEqual(expect.arrayContaining(['required gate unit has no evidence artifact', 'changed files were not resolved from Git for this export']));
    expect(l.assessment.disposition).toBe('IN_PROGRESS');
  });

  it('is deterministic: the same state exports the same document, events in a stable order', () => {
    const { store, id } = runWithGates();
    store.audit(id, 'custom', 'engine', { n: 1 });
    store.audit(id, 'custom', 'engine', { n: 2 });
    const a = buildLedger(store, id, { changedFiles: ['b', 'a'] });
    const b = buildLedger(store, id, { changedFiles: ['a', 'b'] });
    expect(a).toEqual(b);
    expect(a.events.map((e) => e.n)).toEqual([...a.events.keys()].map((k) => k + 1));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.schemaVersion).toBe(1);
  });

  it('keeps credentials out of the ledger even when they reached the incident or the events', () => {
    const { store, id } = runWithGates();
    store.audit(id, 'note', 'engine', { text: `leaked ${FAKE_GH_TOKEN}` });
    incidentsOf({ store, clock: undefined } as never).create({ taskRunId: id, repositoryId: 'o/r', title: `t ${FAKE_GH_TOKEN}`, summary: 's' });
    const text = JSON.stringify(buildLedger(store, id)) + renderLedgerMarkdown(buildLedger(store, id));
    expect(text).not.toContain(FAKE_GH_TOKEN);
  });

  it('escapes backslashes and pipes so table cells cannot be broken out of', () => {
    const { store, id } = runWithGates();
    incidentsOf({ store, clock: undefined } as never).create({ taskRunId: id, repositoryId: 'o/r', title: 't', summary: 's', symptoms: ['a \\| b'] });
    store.audit(id, 'note', 'engine', { text: 'x' });
    const md = renderLedgerMarkdown({ ...buildLedger(store, id), task: { ...buildLedger(store, id).task, intent: 'a\\|b | c\nd' } });
    expect(md).toContain('Intent: a\\\\\\|b \\| c d');
  });

  it('reports blocked and cancelled runs as such, with the reason', () => {
    const { store, id } = runWithGates();
    store.transition(id, 'BLOCKED', { actor: 'engine', reason: 'repair budget exhausted' });
    expect(buildLedger(store, id).assessment).toMatchObject({ disposition: 'BLOCKED', blockers: ['repair budget exhausted'] });
    store.transition(id, 'CANCELLED', { actor: 'engine' });
    expect(buildLedger(store, id).assessment.disposition).toBe('CANCELLED');
  });
});

void configSchema;
void createEngine;
