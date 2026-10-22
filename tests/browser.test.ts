import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startApp } from '../src/browser/app';
import { hashDir, mapAcceptance, parsePlaywrightJson } from '../src/browser/playwright';
import { acTraceability } from '../src/browser/traceability';
import { coreBuiltins } from '../src/gates/builtins';
import { type GateRunCtx, runGate } from '../src/gates/runner';
import { Git } from '../src/git/git';
import { tokenize } from '../src/policy/command';
import { advance, makeStore, newRun } from './helpers';
import { validPlan } from './plan-helpers';
import { initRepo, tmp, write } from './repo-helpers';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const SERVER = (bug: boolean) => `const http=require('http');http.createServer((q,r)=>{r.setHeader('content-type','text/plain');r.end(${bug ? "'total: 99'" : "'total: 100'"})}).listen(Number(process.argv[2]),'127.0.0.1');`;
const E2E = `const persona=process.env.PROOFLOOP_PERSONA||'default';fetch(process.env.APP_URL).then(r=>r.text()).then(t=>{console.log('persona',persona,t);process.exit(t==='total: 100'&&persona!=='unauthorized-user'?0:1)})`;

async function setup(bug = false, e2e = E2E) {
  const port = await freePort();
  const root = await initRepo({ 'server.js': SERVER(bug), 'e2e.js': e2e, 'package.json': '{"name":"x"}' });
  const git = new Git();
  const { store, clock } = makeStore();
  const run = newRun(store);
  const head = await git.head(root);
  store.setFields(run.id, { headSha: head, baseCommit: head });
  const url = `http://127.0.0.1:${port}/`;
  const policy = { allowed: [tokenize('node e2e.js'), tokenize(`node server.js ${port}`), tokenize('node')] };
  const base: GateRunCtx = { store, runId: run.id, cwd: root, commitSha: head, policy, git, artifactDir: join(tmp(), 'art'), timeoutMs: 20_000, environment: 'test', clock, builtins: coreBuiltins };
  const withApp = (over: Partial<GateRunCtx> = {}, start = `node server.js ${port}`): GateRunCtx => ({ ...base, startApp: () => startApp({ cwd: root, start, url, timeoutMs: 5000, policy }), ...over });
  const entry = { gateId: 'browser', kind: 'browser' as const, required: true, command: 'node e2e.js', source: 'config' as const };
  return { root, port, url, store, run, withApp, entry, base };
}

describe('app lifecycle', () => {
  it('starts, waits for readiness, and stops the whole process group', async () => {
    const s = await setup();
    const app = await startApp({ cwd: s.root, start: `node server.js ${s.port}`, url: s.url, timeoutMs: 5000, policy: { allowed: [tokenize('node')] } });
    expect((await fetch(s.url)).status).toBe(200);
    await app.stop();
    await expect(fetch(s.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });

  it('refuses commands outside policy, and reports apps that die or never become ready', async () => {
    const s = await setup();
    await expect(startApp({ cwd: s.root, start: 'python -m http.server', url: s.url, timeoutMs: 500, policy: { allowed: [tokenize('node')] } })).rejects.toThrow(/refused by policy/);
    await expect(startApp({ cwd: s.root, start: 'node -e "process.exit(3)"', url: s.url, timeoutMs: 3000, policy: { allowed: [tokenize('node')] } })).rejects.toThrow(/exited before becoming ready/);
    await expect(startApp({ cwd: s.root, start: 'node -e "setInterval(()=>{},1000)"', url: s.url, timeoutMs: 600, policy: { allowed: [tokenize('node')] } })).rejects.toThrow(/did not become ready/);
  });

  it('seeds known data before starting and fails if seeding fails', async () => {
    const s = await setup();
    write(s.root, 'seed.js', "require('fs').writeFileSync('seeded.txt','1')");
    const app = await startApp({ cwd: s.root, start: `node server.js ${s.port}`, seed: 'node seed.js', url: s.url, timeoutMs: 5000, policy: { allowed: [tokenize('node')] } });
    await app.stop();
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(s.root, 'seeded.txt'))).toBe(true);
    await expect(startApp({ cwd: s.root, start: `node server.js ${s.port}`, seed: 'node -e "process.exit(2)"', url: s.url, timeoutMs: 1000, policy: { allowed: [tokenize('node')] } })).rejects.toThrow(/seed command failed/);
  });
});

describe('browser gate', () => {
  it('PASS against the correct app, and FAIL when the known-bug app is run (AC7)', async () => {
    const good = await setup(false);
    expect((await runGate(good.withApp(), good.entry)).state).toBe('PASS');
    const bad = await setup(true);
    const r = await runGate(bad.withApp(), bad.entry);
    expect(r).toMatchObject({ state: 'FAIL', failureCategory: 'nonzero-exit' });
  });

  it('is BLOCKED, never a pass, when the app cannot start or the browser is unavailable (AC4)', async () => {
    const s = await setup();
    const noStart = await runGate(s.withApp({}, 'node -e "process.exit(1)"'), s.entry);
    expect(noStart).toMatchObject({ state: 'BLOCKED', failureCategory: 'app-start-failed' });
    const noBrowser = await setup(false, `console.error("browserType.launch: Executable doesn't exist at /x");process.exit(1)`);
    expect(await runGate(noBrowser.withApp(), noBrowser.entry)).toMatchObject({ state: 'BLOCKED', failureCategory: 'environment' });
  });

  it('runs once per persona and takes the worst outcome, recording each persona', async () => {
    const s = await setup();
    const r = await runGate(s.withApp({ personas: ['ordinary-user', 'unauthorized-user', 'impatient-user'] }), s.entry);
    expect(r.state).toBe('FAIL');
    expect(r.commandOrAssertion).toContain('personas: ordinary-user, unauthorized-user, impatient-user');
    const { readFileSync } = await import('node:fs');
    const log = readFileSync(String(s.store.evidenceFor(s.run.id)[0]!.uri), 'utf8');
    expect(log).toContain('persona ordinary-user: PASS');
    expect(log).toContain('persona unauthorized-user: FAIL');
  });

  it('hashes trace and screenshot directories into the evidence ledger with the commit', async () => {
    const s = await setup(false, `require('fs').mkdirSync('test-results',{recursive:true});require('fs').writeFileSync('test-results/trace.zip','TRACE');process.exit(0)`);
    const r = await runGate(s.withApp({ artifactDirs: ['test-results'] }), s.entry);
    expect(r.state).toBe('PASS');
    const ev = s.store.evidenceFor(s.run.id).find((e) => e.kind === 'browser-artifacts')!;
    expect(ev.commit_sha).toBe(s.run.headSha ?? ev.commit_sha);
    expect(ev.checksum).toBe(hashDir(join(s.root, 'test-results')));
  });

  it('directory evidence is snapshotted, survives the next test run, and tampering with the snapshot is detected', async () => {
    const s = await setup(false, `require('fs').mkdirSync('test-results',{recursive:true});require('fs').writeFileSync('test-results/trace.zip','TRACE');process.exit(0)`);
    s.store.setGatePlan(s.run.id, [{ gateId: 'browser', kind: 'browser', required: true, command: 'node e2e.js' }]);
    await runGate(s.withApp({ artifactDirs: ['test-results'] }), s.entry);
    const { verifyEvidenceIntegrity } = await import('../src/engine/report');
    expect(verifyEvidenceIntegrity(s.store, s.run.id)).toEqual([]);
    writeFileSync(join(s.root, 'test-results', 'trace.zip'), 'NEXT RUN REWROTE THE DIRECTORY'); // evidence is a snapshot
    expect(verifyEvidenceIntegrity(s.store, s.run.id)).toEqual([]);
    const snap = String(s.store.evidenceFor(s.run.id).find((e) => e.kind === 'browser-artifacts')!.uri);
    writeFileSync(join(snap, 'trace.zip'), 'TAMPERED');
    expect(verifyEvidenceIntegrity(s.store, s.run.id).map((p) => p.problem).join()).toContain('checksum mismatch');
  });

  it('the app is stopped after the gate even when the test fails', async () => {
    const s = await setup(true);
    await runGate(s.withApp(), s.entry);
    await expect(fetch(s.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });
});

const REPORT = JSON.stringify({
  suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: [{ title: 'lists users @AC-1', tests: [{ status: 'expected' }] }, { title: 'empty state @AC-2', tests: [{ status: 'unexpected' }] }], suites: [{ title: 'nested', specs: [{ title: 'denied @AC-3', tags: ['@AC-3'], tests: [{ status: 'flaky' }] }, { title: 'skipped @AC-4', tests: [{ status: 'skipped' }] }] }] }],
});

describe('Playwright results and acceptance traceability (AC1, AC6)', () => {
  it('parses nested suites and maps tagged tests to criteria', () => {
    const rows = mapAcceptance(['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'], parsePlaywrightJson(REPORT));
    expect(rows.map((r) => [r.ac, r.executed, r.failed])).toEqual([['AC-1', 1, 0], ['AC-2', 1, 1], ['AC-3', 1, 1], ['AC-4', 0, 0], ['AC-5', 0, 0]]);
  });

  async function traced(files: Record<string, string>, tests: string[], manual = false, resultsFile?: string) {
    const root = await initRepo(files);
    const git = new Git();
    const { store, clock } = makeStore();
    const run = newRun(store);
    advance(store, run.id, 'DISCOVERING', 'PLANNING');
    const ac = manual ? { id: 'AC-1', text: 'Looks right to a designer', tests: [], manual: { reason: 'visual judgement call' } } : { id: 'AC-1', text: 'Users are listed', tests };
    store.recordPlan(run.id, validPlan({ acceptanceCriteria: [ac] }), 'h');
    const head = await git.head(root);
    store.setFields(run.id, { headSha: head, baseCommit: head });
    return acTraceability({ store, runId: run.id, cwd: root, commitSha: head, policy: { allowed: [] }, git, artifactDir: tmp(), timeoutMs: 1000, environment: 't', clock, resultsFile });
  }

  it('fails criteria that point at tests which do not exist; accepts real files, selectors and documented manual checks', async () => {
    expect(await traced({ 'a.txt': '1' }, ['tests/ghost.spec.ts'])).toMatchObject({ state: 'FAIL', category: 'untraceable-criteria' });
    expect((await traced({ 'tests/real.spec.ts': 'x' }, ['tests/real.spec.ts'])).state).toBe('PASS');
    expect((await traced({ 'a.txt': '1' }, ['pytest tests -k users'])).summary).toContain('not file-checked');
    expect((await traced({ 'a.txt': '1' }, [], true)).summary).toContain('manual check');
  });

  it('uses the Playwright report when configured: failures fail, a missing report is BLOCKED', async () => {
    const failing = JSON.stringify({ suites: [{ specs: [{ title: 'x @AC-1', tests: [{ status: 'unexpected' }] }] }] });
    const ok = JSON.stringify({ suites: [{ specs: [{ title: 'x @AC-1', tests: [{ status: 'expected' }] }] }] });
    expect(await traced({ 'tests/real.spec.ts': 'x', 'r.json': failing }, ['tests/real.spec.ts'], false, 'r.json')).toMatchObject({ state: 'FAIL', category: 'assertion-failed' });
    expect((await traced({ 'tests/real.spec.ts': 'x', 'r.json': ok }, ['tests/real.spec.ts'], false, 'r.json')).summary).toContain('tagged browser tests passed');
    expect(await traced({ 'tests/real.spec.ts': 'x' }, ['tests/real.spec.ts'], false, 'missing.json')).toMatchObject({ state: 'BLOCKED', category: 'no-results' });
  });

  it('hashDir is stable and content-sensitive', () => {
    const d = tmp();
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 'a'), '1');
    const h1 = hashDir(d);
    expect(hashDir(d)).toBe(h1);
    writeFileSync(join(d, 'sub', 'a'), '2');
    expect(hashDir(d)).not.toBe(h1);
    expect(hashDir(join(d, 'nope'))).toBeNull();
  });
});
