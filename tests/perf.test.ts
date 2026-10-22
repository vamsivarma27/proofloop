import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { addArtifact, baselineRecorded, beforeAfter, migrationReadiness, missingArtifacts } from '../src/gates/artifacts';
import { coreBuiltins } from '../src/gates/builtins';
import { type GateRunCtx, runGate } from '../src/gates/runner';
import { Git } from '../src/git/git';
import { type Measurement, MIN_SAMPLES, evaluatePerformance, fromK6Summary, summarize, unsupportedScaleClaims } from '../src/perf/report';
import { recordMeasurement } from '../src/perf/record';
import { SqliteQueryPlanAdapter } from '../src/perf/queryplan';
import { renderReadiness } from '../src/engine/report';
import { makeStore, newRun } from './helpers';
import { initRepo, tmp, write } from './repo-helpers';

const samples = (center: number, n = 40): number[] => Array.from({ length: n }, (_, i) => center + (i % 5));
const m = (over: Partial<Measurement> = {}): Measurement => ({
  phase: 'baseline', kind: 'simulated', environment: 'staging-hw-1',
  workload: { description: 'list 50k conversations', dataset: 'seed-50k', concurrency: 20 },
  target: { metric: 'p95', comparator: '<=', value: 200, unit: 'ms' },
  commit: 'abcdef1234', capturedAt: '2026-10-22T10:00:00Z', samples: samples(400), ...over,
});

describe('performance verdicts (v0.6 AC1, AC2, AC5)', () => {
  it('summarizes with nearest-rank percentiles', () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(s).toMatchObject({ n: 100, min: 1, max: 100, p50: 50, p95: 95, p99: 99 });
  });

  it('requires a baseline, the same workload/target/environment, and enough samples', () => {
    const base = m();
    const after = m({ phase: 'after', samples: samples(150) });
    expect(evaluatePerformance(undefined, after)).toMatchObject({ kind: 'INVALID', reason: expect.stringContaining('no baseline') });
    expect(evaluatePerformance(base, undefined)).toMatchObject({ kind: 'INVALID' });
    expect(evaluatePerformance(base, { ...after, workload: { ...after.workload, dataset: 'other' } })).toMatchObject({ kind: 'INVALID', reason: expect.stringContaining('workload differs') });
    expect(evaluatePerformance(base, { ...after, target: { ...after.target, value: 100 } })).toMatchObject({ kind: 'INVALID' });
    expect(evaluatePerformance(base, { ...after, kind: 'live-observation' })).toMatchObject({ kind: 'INVALID', reason: expect.stringContaining('cannot compare') });
    expect(evaluatePerformance(base, { ...after, environment: 'laptop' })).toMatchObject({ kind: 'INVALID' });
    expect(evaluatePerformance(base, m({ phase: 'after', samples: [100, 110] }))).toMatchObject({ kind: 'INVALID', reason: expect.stringContaining(`at least ${MIN_SAMPLES}`) });
  });

  it('declares success only when the stated target is met by a real improvement', () => {
    expect(evaluatePerformance(m(), m({ phase: 'after', samples: samples(150) })).kind).toBe('TARGET_MET');
    expect(evaluatePerformance(m(), m({ phase: 'after', samples: samples(300) })).kind).toBe('TARGET_NOT_MET');
    expect(evaluatePerformance(m(), m({ phase: 'after', samples: samples(398) })).kind).toBe('NO_SIGNIFICANT_CHANGE');
    expect(evaluatePerformance(m(), m({ phase: 'after', samples: samples(600) })).kind).toBe('REGRESSION');
    const tput = (c: number): Partial<Measurement> => ({ target: { metric: 'throughput', comparator: '>=', value: 500, unit: 'rps' }, samples: undefined, summary: { n: 5000, throughput: c } });
    expect(evaluatePerformance(m(tput(300)), m({ phase: 'after', ...tput(700) })).kind).toBe('TARGET_MET');
  });

  it('refuses scalability claims that are not backed by a met target', () => {
    const text = 'The service now scales to 10,000 users and handles 5000 rps.';
    expect(unsupportedScaleClaims(text, null).length).toBe(2);
    expect(unsupportedScaleClaims(text, { kind: 'NO_SIGNIFICANT_CHANGE', baseline: 1, after: 1, improvement: 0 }).length).toBe(2);
    expect(unsupportedScaleClaims(text, { kind: 'TARGET_MET', baseline: 400, after: 150, improvement: 0.6 })).toEqual([]);
    expect(unsupportedScaleClaims('We reduced p95 latency.', null)).toEqual([]);
  });

  it('imports a k6 summary as a labeled simulated measurement', () => {
    const k6 = { metrics: { http_req_duration: { med: 90, 'p(95)': 180, 'p(99)': 240, avg: 100 }, http_reqs: { count: 6000, rate: 200 }, http_req_failed: { value: 0.001 } } };
    const meas = fromK6Summary(k6, { phase: 'after', environment: 'staging-hw-1', workload: m().workload, target: m().target, commit: 'abcdef1234', capturedAt: '2026-10-22T10:00:00Z' });
    expect(meas.kind).toBe('simulated');
    expect(meas.summary).toMatchObject({ n: 6000, p95: 180, throughput: 200 });
  });
});

describe('query-plan inspection', () => {
  it('flags full scans and recognizes index use, and refuses anything but one SELECT', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pl-qp-')), 'x.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE conversation (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT); CREATE INDEX conversation_user ON conversation(user_id);');
    db.close();
    const a = new SqliteQueryPlanAdapter(path);
    const [scan, indexed] = a.inspect(['SELECT * FROM conversation WHERE title = ?', 'SELECT * FROM conversation WHERE user_id = ?']);
    expect(scan!.fullScans.length).toBe(1);
    expect(indexed).toMatchObject({ usesIndex: true, fullScans: [] });
    expect(() => a.inspect(['DELETE FROM conversation'])).toThrow(/single SELECT/);
    expect(() => a.inspect(['SELECT 1; DROP TABLE conversation'])).toThrow(/single SELECT/);
  });
});

async function ctxFor(files: Record<string, string> = { 'a.txt': '1' }) {
  const root = await initRepo(files);
  const git = new Git();
  const { store, clock } = makeStore();
  const run = newRun(store);
  const head = await git.head(root);
  store.setFields(run.id, { headSha: head, baseCommit: head });
  const art = join(tmp(), 'art');
  const ctx: GateRunCtx = { store, runId: run.id, cwd: root, commitSha: head, policy: { allowed: [] }, git, artifactDir: art, timeoutMs: 5000, environment: 't', clock, builtins: { ...coreBuiltins, 'migration-readiness': migrationReadiness, 'baseline-recorded': baselineRecorded, 'before-after': beforeAfter } };
  return { root, git, store, run, ctx, head, art };
}

describe('performance gates read recorded evidence only', () => {
  it('BLOCKED without a baseline, FAIL on no improvement, PASS only when the target is met on the candidate commit', async () => {
    const { store, run, ctx, head, art } = await ctxFor();
    expect(await baselineRecorded(ctx)).toMatchObject({ state: 'BLOCKED', category: 'no-baseline' });
    recordMeasurement(store, run.id, m({ commit: head }), art);
    expect((await baselineRecorded(ctx)).state).toBe('PASS');
    expect(await beforeAfter(ctx)).toMatchObject({ state: 'BLOCKED', category: 'invalid-measurement' });
    recordMeasurement(store, run.id, m({ phase: 'after', commit: head, samples: samples(399) }), art);
    expect(await beforeAfter(ctx)).toMatchObject({ state: 'FAIL', category: 'no-improvement' });
    recordMeasurement(store, run.id, m({ phase: 'after', commit: head, samples: samples(150) }), art);
    const ok = await beforeAfter(ctx);
    expect(ok.state).toBe('PASS');
    expect(ok.summary).toContain('simulated measurement');
  });

  it('a measurement of some other commit is stale, and invalid measurements are rejected at record time', async () => {
    const { store, run, ctx, art } = await ctxFor();
    recordMeasurement(store, run.id, m({ commit: 'ffffffffff' }), art);
    expect(await baselineRecorded(ctx)).toMatchObject({ state: 'BLOCKED', category: 'stale-baseline' });
    expect(() => recordMeasurement(store, run.id, { phase: 'nope' }, art)).toThrow(/invalid measurement/);
    expect(() => recordMeasurement(store, run.id, m({ samples: undefined }), art)).toThrow(/raw samples or a tool summary/);
  });
});

describe('required artifacts and migration readiness', () => {
  it('derives plan-backed artifacts, requires the rest to be recorded', async () => {
    const { store, run, art } = await ctxFor();
    expect(missingArtifacts(store, run.id, ['threat-model', 'verification-report'])).toEqual(['threat-model']);
    addArtifact(store, run.id, { name: 'threat-model', content: 'STRIDE notes', artifactDir: art });
    expect(missingArtifacts(store, run.id, ['threat-model'])).toEqual([]);
    expect(() => addArtifact(store, run.id, { name: 'Bad Name', content: 'x', artifactDir: art })).toThrow(/kebab-case/);
  });

  it('blocks schema changes without rollback notes and fails destructive SQL without a scoped approval (AC3, AC4)', async () => {
    const { root, git, store, run, ctx, art } = await ctxFor({ 'a.txt': '1' });
    write(root, 'db/migrations/001.sql', 'ALTER TABLE lead ADD COLUMN stage TEXT;\n');
    const sha1 = (await git.commitAll(root, 'feat: add column'))!;
    store.setFields(run.id, { headSha: sha1 });
    const c1 = { ...ctx, commitSha: sha1 };
    expect(await migrationReadiness(c1)).toMatchObject({ state: 'BLOCKED', category: 'missing-artifacts' });
    addArtifact(store, run.id, { name: 'rollback-notes', content: 'drop the column; no data lost', artifactDir: art });
    expect((await migrationReadiness(c1)).state).toBe('PASS');

    write(root, 'db/migrations/002.sql', 'DROP TABLE legacy_lead;\n');
    const sha2 = (await git.commitAll(root, 'feat: drop table'))!;
    store.setFields(run.id, { headSha: sha2 });
    const c2 = { ...ctx, commitSha: sha2 };
    expect(await migrationReadiness(c2)).toMatchObject({ state: 'FAIL', category: 'destructive-migration-unapproved' });
    store.recordApproval(run.id, { scope: 'destructive-migration', planHash: null, approvedBy: 'human:t', decision: 'approve' });
    expect((await migrationReadiness(c2)).state).toBe('PASS');
  });

  it('passes trivially when no migrations changed', async () => {
    const { ctx } = await ctxFor();
    expect((await migrationReadiness(ctx)).state).toBe('PASS');
  });
});

describe('environment guard and readiness report (AC4, AC5)', () => {
  it('production environment blocks gate commands until a gate-scoped approval exists', async () => {
    const { store, run, ctx } = await ctxFor();
    const prod: GateRunCtx = { ...ctx, environmentKind: 'production', policy: { allowed: [['node']] } };
    const entry = { gateId: 'integration', kind: 'integration' as const, required: true, command: 'node -e 0', source: 'config' as const };
    expect(await runGate(prod, entry)).toMatchObject({ state: 'BLOCKED', failureCategory: 'production-environment' });
    expect(store.events(run.id, 'policy.denied').length).toBe(1);
    store.recordApproval(run.id, { scope: 'production:integration', planHash: null, approvedBy: 'human:t', decision: 'approve' });
    expect((await runGate(prod, entry)).state).toBe('PASS');
    expect((await runGate({ ...ctx, environmentKind: 'staging', policy: { allowed: [['node']] } }, entry)).state).toBe('PASS');
  });

  it('readiness report labels simulated vs live evidence and lists artifacts and limitations', async () => {
    const { store, run, art, head } = await ctxFor();
    recordMeasurement(store, run.id, m({ commit: head }), art);
    addArtifact(store, run.id, { name: 'threat-model', content: 'x', artifactDir: art });
    const r = renderReadiness(store, run.id);
    expect(r).toContain('simulated measurements come from synthetic load');
    expect(r).toContain('- threat-model');
    const empty = await ctxFor();
    expect(renderReadiness(empty.store, empty.run.id)).toContain('no performance or scalability claim is supported');
  });
});
