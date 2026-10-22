import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coreBuiltins } from '../src/gates/builtins';
import { buildGatePlan, resolveCommand } from '../src/gates/plan';
import { type GateRunCtx, failureFingerprint, gateReport, runGate, runGates } from '../src/gates/runner';
import { Git } from '../src/git/git';
import { loadRegistry } from '../src/protocol/registry';
import { sha256 } from '../src/shared/hash';
import { advance, makeStore, newRun } from './helpers';
import { initRepo, tmp, write } from './repo-helpers';

async function setup(files: Record<string, string> = { 'a.txt': '1\n' }) {
  const root = await initRepo(files);
  const git = new Git();
  const { store, clock } = makeStore();
  const run = newRun(store);
  const head = await git.head(root);
  store.setFields(run.id, { headSha: head, baseCommit: head });
  const ctx: GateRunCtx = { store, runId: run.id, cwd: root, commitSha: head, policy: { allowed: [['node']] }, git, artifactDir: join(tmp(), 'art'), timeoutMs: 20_000, environment: 'test', clock, builtins: coreBuiltins };
  const entry = (command: string | null, id = 'unit', required = true) => ({ gateId: id, kind: 'unit' as const, required, command, source: 'config' as const });
  return { root, git, store, run, head, ctx, entry };
}

describe('gate runner', () => {
  it('PASS records evidence tied to the commit with a matching checksum', async () => {
    const { ctx, entry, head, store, run } = await setup();
    const r = await runGate(ctx, entry('node -e "console.log(42)"'));
    expect(r.state).toBe('PASS');
    expect(r.commitSha).toBe(head);
    const ev = store.evidenceFor(run.id)[0]!;
    expect(sha256(readFileSync(ev.uri as string, 'utf8'))).toBe(ev.checksum);
    expect(ev.commit_sha).toBe(head);
    expect(readFileSync(ev.uri as string, 'utf8')).toContain('42');
  });

  it('FAIL on non-zero exit with a stable fingerprint; failure preserved', async () => {
    const { ctx, entry } = await setup();
    const a = await runGate(ctx, entry('node -e "console.error(\'boom 12:00ms\');process.exit(3)"'));
    const b = await runGate(ctx, entry('node -e "console.error(\'boom 99:00ms\');process.exit(3)"'));
    expect(a).toMatchObject({ state: 'FAIL', exitCode: 3, failureCategory: 'nonzero-exit' });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('FAIL (not pass) on timeout', async () => {
    const { ctx, entry } = await setup();
    const r = await runGate({ ...ctx, timeoutMs: 300 }, entry('node -e "setTimeout(()=>{},10000)"'));
    expect(r).toMatchObject({ state: 'FAIL', failureCategory: 'timeout' });
  });

  it('BLOCKED when no command is detected (nothing invented)', async () => {
    const { ctx, entry } = await setup();
    expect(await runGate(ctx, entry(null))).toMatchObject({ state: 'BLOCKED', failureCategory: 'command-not-detected' });
  });

  it('BLOCKED when the executable does not exist', async () => {
    const { ctx, entry } = await setup();
    const r = await runGate({ ...ctx, policy: { allowed: [['definitely-not-a-binary']] } }, entry('definitely-not-a-binary --x'));
    expect(r).toMatchObject({ state: 'BLOCKED', failureCategory: 'executable-missing' });
  });

  it('BLOCKED and audited when policy refuses the command (Scenario E)', async () => {
    const { ctx, entry, store, run } = await setup();
    const unlisted = await runGate(ctx, entry('python evil.py'));
    expect(unlisted).toMatchObject({ state: 'BLOCKED', failureCategory: 'policy-denied' });
    const destructive = await runGate({ ...ctx, policy: { allowed: [['rm']] } }, entry('rm -rf build'));
    expect(destructive).toMatchObject({ state: 'BLOCKED', failureCategory: 'policy-denied' });
    expect(store.events(run.id, 'policy.denied').length).toBe(2);
  });

  it('runs a critical command only after an explicit scoped approval', async () => {
    const { ctx, entry, store, run } = await setup();
    const c = { ...ctx, policy: { allowed: [['rm']] } };
    const scope = 'destructive:rm -rf nothing-here';
    store.recordApproval(run.id, { scope, planHash: null, approvedBy: 'human:t', decision: 'approve' });
    expect((await runGate(c, entry('rm -rf nothing-here'))).state).toBe('PASS');
  });

  it('BLOCKED on a dirty tree or a moved HEAD: evidence must map to the commit', async () => {
    const { ctx, entry, root, git } = await setup();
    write(root, 'dirty.txt', 'x');
    expect(await runGate(ctx, entry('node -e "0"'))).toMatchObject({ state: 'BLOCKED', failureCategory: 'dirty-tree' });
    await git.commitAll(root, 'feat: more');
    expect(await runGate(ctx, entry('node -e "0"'))).toMatchObject({ state: 'BLOCKED', failureCategory: 'commit-mismatch' });
  });

  it('redacts secrets from persisted logs', async () => {
    const { ctx, entry, store, run } = await setup();
    await runGate(ctx, entry('node -e "console.log(\'key=\' + \'ghp_\' + \'a\'.repeat(36))"'));
    expect(readFileSync(store.evidenceFor(run.id)[0]!.uri as string, 'utf8')).not.toContain('ghp_aaaa');
  });

  it('does not leak ambient credentials into gate processes', async () => {
    const { ctx, entry, store, run } = await setup();
    process.env.PL_TEST_SECRET_TOKEN = 'supersecretvalue123';
    try {
      await runGate(ctx, entry('node -e "console.log(process.env.PL_TEST_SECRET_TOKEN ?? \'absent\')"'));
    } finally {
      delete process.env.PL_TEST_SECRET_TOKEN;
    }
    expect(readFileSync(store.evidenceFor(run.id)[0]!.uri as string, 'utf8')).toContain('absent');
  });

  it('gateReport marks results on an old commit as stale and requires every required gate', async () => {
    const { ctx, entry, store, run, git, root } = await setup();
    store.setGatePlan(run.id, [{ gateId: 'unit', kind: 'unit', required: true, command: 'x' }, { gateId: 'lint', kind: 'lint', required: true, command: 'x' }]);
    await runGates(ctx, [entry('node -e "0"', 'unit'), entry('node -e "process.exit(1)"', 'lint')]);
    expect(gateReport(store, run.id).allRequiredPass).toBe(false);
    await runGate(ctx, entry('node -e "0"', 'lint'));
    expect(gateReport(store, run.id).allRequiredPass).toBe(true);
    write(root, 'n.txt', '1');
    const sha = (await git.commitAll(root, 'feat: n'))!;
    store.setFields(run.id, { headSha: sha });
    const rep = gateReport(store, run.id);
    expect(rep.allRequiredPass).toBe(false);
    expect(rep.gates.every((g) => g.stale)).toBe(true);
  });

  it('fingerprint ignores timestamps, durations and paths', () => {
    expect(failureFingerprint('FAIL /tmp/a/b.ts 12ms 2026-01-01T00:00:00Z')).toBe(failureFingerprint('FAIL /var/c/d.ts 99ms 2027-05-05T10:10:10Z'));
    expect(failureFingerprint('FAIL one')).not.toBe(failureFingerprint('ERROR two'));
  });
});

describe('builtin gates', () => {
  it('test-integrity fails on weakened tests unless a test-change is approved', async () => {
    const { ctx, root, git, store, run } = await setup({ 'tests/a.test.ts': "expect(a).toBe(1);\nexpect(b).toBe(2);\n", 'src/a.ts': 'x' });
    write(root, 'tests/a.test.ts', 'expect(a).toBe(1);\n');
    const sha = (await git.commitAll(root, 'test: loosen'))!;
    store.setFields(run.id, { headSha: sha });
    const c = { ...ctx, commitSha: sha };
    const e = { gateId: 'test-integrity', kind: 'custom' as const, required: true, command: 'builtin:test-integrity', source: 'builtin' as const };
    expect(await runGate(c, e)).toMatchObject({ state: 'FAIL', failureCategory: 'test-weakened' });
    store.recordApproval(run.id, { scope: 'test-change', planHash: null, approvedBy: 'human:t', decision: 'approve' });
    expect((await runGate(c, e)).state).toBe('PASS');
  });

  it('contract-drift fails on changed exports until approved', async () => {
    const { ctx, root, git, store, run } = await setup({ 'src/a.ts': 'export const a = 1;\n' });
    write(root, 'src/a.ts', 'export const b = 1;\n');
    const sha = (await git.commitAll(root, 'refactor: rename'))!;
    store.setFields(run.id, { headSha: sha });
    const c = { ...ctx, commitSha: sha };
    const e = { gateId: 'contract-drift', kind: 'custom' as const, required: true, command: 'builtin:contract-drift', source: 'builtin' as const };
    expect((await runGate(c, e)).state).toBe('FAIL');
    store.recordApproval(run.id, { scope: 'behavior-change', planHash: null, approvedBy: 'human:t', decision: 'approve' });
    expect((await runGate(c, e)).state).toBe('PASS');
  });

  it('a missing builtin evaluator is BLOCKED, never a pass', async () => {
    const { ctx } = await setup();
    const r = await runGate({ ...ctx, builtins: {} }, { gateId: 'x', kind: 'custom', required: true, command: 'builtin:nope', source: 'builtin' });
    expect(r).toMatchObject({ state: 'BLOCKED', failureCategory: 'builtin-missing' });
  });
});

describe('gate plan', () => {
  const feature = loadRegistry().get('feature');
  it('binds detected commands, leaves the rest unbound, and honors risk thresholds', () => {
    const plan = buildGatePlan(feature, 'medium', { commands: { lint: 'pnpm run lint', unit: 'pnpm run test' } }, { commands: {} });
    const byId = Object.fromEntries(plan.map((g) => [g.gateId, g]));
    expect(byId.lint).toMatchObject({ command: 'pnpm run lint', source: 'detected' });
    expect(byId.build).toMatchObject({ command: null, source: 'none', required: false, unsupported: true });
    expect(byId.integration).toBeDefined();
    expect(byId.browser).toBeUndefined();
    const high = Object.fromEntries(buildGatePlan(feature, 'high', { commands: {} }, { commands: {} }).map((g) => [g.gateId, g]));
    expect(high.browser).toMatchObject({ required: true, command: null });
    expect(high.build?.unsupported).toBeUndefined();
  });

  it('prefers plan > builtin > config > detected', () => {
    const g = { id: 'unit', kind: 'unit' as const };
    expect(resolveCommand(g, { commands: { unit: 'det' } }, { commands: { unit: 'cfg' } }).source).toBe('config');
    expect(resolveCommand(g, { commands: { unit: 'det' } }, { commands: { unit: 'cfg' } }, { unit: 'plan' }).command).toBe('plan');
    expect(resolveCommand({ id: 'contract-drift', kind: 'custom' }, { commands: {} }, { commands: {} }).source).toBe('builtin');
  });

  it('an end-to-end DB check: store only reaches REVIEW_REQUIRED via real gate results', async () => {
    const { store, run, ctx, entry } = await setup();
    store.setGatePlan(run.id, [{ gateId: 'unit', kind: 'unit', required: true, command: 'x' }]);
    store.transition(run.id, 'DISCOVERING', { actor: 't' });
    store.transition(run.id, 'PLANNING', { actor: 't' });
    store.recordPlan(run.id, { p: 1 }, 'h');
    advance(store, run.id, 'AWAITING_APPROVAL');
    store.recordApproval(run.id, { scope: 'plan', planHash: 'h', approvedBy: 'human:t', decision: 'approve' });
    advance(store, run.id, 'APPROVED', 'READY', 'RUNNING', 'VERIFYING');
    await runGate(ctx, entry('node -e "process.exit(2)"'));
    expect(() => store.transition(run.id, 'REVIEW_REQUIRED', { actor: 'e' })).toThrow(/not passing/);
    await runGate(ctx, entry('node -e "0"'));
    expect(store.transition(run.id, 'REVIEW_REQUIRED', { actor: 'e' }).state).toBe('REVIEW_REQUIRED');
  });
});
