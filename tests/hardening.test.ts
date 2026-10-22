import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalToolComposer, sandboxSupport } from '../src/composer/local';
import { evaluateHook } from '../src/cli/hook';
import { verifyEvidenceIntegrity } from '../src/engine/report';
import { analyzeTestDiff } from '../src/gates/integrity';
import { coreBuiltins } from '../src/gates/builtins';
import { type GateRunCtx, runGate } from '../src/gates/runner';
import { Git } from '../src/git/git';
import { checkPath } from '../src/policy/paths';
import { redact } from '../src/shared/redact';
import { implementerTools } from '../src/engine/deps';
import { advance, gate, makeStore, newRun, toRunning } from './helpers';
import { agents, approveAndRun, engineFor, project } from './engine-helpers';
import { initRepo, tmp, write } from './repo-helpers';

describe('ledger forgery (independent review #1)', () => {
  it('rows inserted straight into the database without the key are ignored by the guards and reported at delivery', () => {
    const { store } = makeStore();
    const run = newRun(store);
    toRunning(store, run.id);
    advance(store, run.id, 'VERIFYING');
    store.db.prepare(`INSERT INTO gate_result (id, task_run_id, gate_id, state, required, command_or_assertion, exit_code, evidence_ids, commit_sha, started_at_utc, finished_at_utc, seq, sig) VALUES ('forged1', ?, 'unit', 'PASS', 1, 'forged', 0, '[]', 'abc123', 't', 't', 99, 'not-a-signature')`).run(run.id);
    expect(store.forgedGateRows(run.id)).toBe(1);
    expect(() => store.transition(run.id, 'REVIEW_REQUIRED', { actor: 'a' })).toThrow(/not passing/);
    expect(verifyEvidenceIntegrity(store, run.id).map((p) => p.problem).join()).toContain('failed signature verification');
    gate(store, run.id, 'PASS');
    expect(store.transition(run.id, 'REVIEW_REQUIRED', { actor: 'a' }).state).toBe('REVIEW_REQUIRED');
  });

  it('forged approvals and a hand-edited approved_plan_hash column do not authorize anything', () => {
    const { store } = makeStore();
    const run = newRun(store);
    advance(store, run.id, 'DISCOVERING', 'PLANNING');
    store.recordPlan(run.id, { v: 1 }, 'h1');
    advance(store, run.id, 'AWAITING_APPROVAL');
    store.db.prepare(`UPDATE task_run SET approved_plan_hash = 'h1' WHERE id = ?`).run(run.id);
    store.db.prepare(`INSERT INTO approval (id, task_run_id, scope, plan_hash, approved_by, decision, created_at_utc, sig) VALUES ('f1', ?, 'plan', 'h1', 'human:x', 'approve', 't', 'bad')`).run(run.id);
    store.db.prepare(`INSERT INTO approval (id, task_run_id, scope, plan_hash, approved_by, decision, created_at_utc, sig) VALUES ('f2', ?, 'test-change', NULL, 'human:x', 'approve', 't', 'bad')`).run(run.id);
    expect(() => store.transition(run.id, 'APPROVED', { actor: 'a' })).toThrow(/not been approved/);
    expect(store.hasGatedApproval(run.id, 'test-change')).toBe(false);
    expect(store.forgedApprovalRows(run.id)).toBe(2);
  });

  it('implementer tools allow gate commands exactly, with no wildcard for flag injection, and cannot reach state', async () => {
    const e = await engineFor(await project(), agents());
    const { runId } = await approveAndRun(e);
    const tools = implementerTools(e.d, runId);
    expect(tools.filter((t) => /^Bash\((npm|node|pnpm|yarn)\b/.test(t))).toEqual(expect.arrayContaining([expect.stringMatching(/^Bash\(npm run test\)$/)]));
    expect(tools.some((t) => /^Bash\((npm|node|pnpm|yarn)\b.* \*\)$/.test(t))).toBe(false);
    const { ALWAYS_DENIED } = await import('../src/agent/runtime');
    expect(ALWAYS_DENIED).toEqual(expect.arrayContaining(['Bash(sqlite3 *)', 'Read(**/.proofloop/**)']));
  });
});

describe('hook and policy bypasses (#2, #3, #7)', () => {
  const agent = { PROOFLOOP_AGENT_SESSION: '1' };
  const bash = (command: string, env: NodeJS.ProcessEnv = {}) => evaluateHook({ tool_name: 'Bash', tool_input: { command }, cwd: process.cwd() }, env).decision;

  it('judges every segment of compound commands and flag-reordered variants', () => {
    for (const c of ['ls; terraform apply', 'cd x && kubectl delete ns prod', 'echo $(npm publish)', 'rm -r -f build', 'git -C . push --force', 'terraform -chdir=prod apply', 'kubectl -n prod delete pod x'])
      expect(bash(c, agent), c).toBe('deny');
    expect(bash('git -C . push --force')).toBe('ask');
    expect(bash('ls | wc -l', agent)).toBe('allow');
  });

  it('denies agents any route to the state database, ledger key or the CLI internals; asks humans', () => {
    for (const c of ['sqlite3 .proofloop/state.db "insert into approval ..."', 'node dist/cli.js approve run_1 --yes', 'cat ~/.proofloop/ledger.key', 'bash -c "echo > .proofloop/state.db"'])
      expect(bash(c, agent), c).toBe('deny');
    expect(bash('node dist/cli.js approve run_1')).toBe('ask');
  });

  it('path deny lists are case-insensitive and cover more credential files', () => {
    const root = tmp();
    for (const p of ['.ENV', '.Git/hooks/x', '.npmrc', '.netrc', '.envrc', 'K.PEM']) expect(checkPath(root, p, 'write').ok, p).toBe(false);
    for (const p of ['.kube/config', '.docker/config.json', '.proofloop/state.db', '.npmrc']) expect(checkPath(root, p, 'read').ok, p).toBe(false);
  });

  it('a staged rename is reported with its source so out-of-scope moves are caught', async () => {
    const root = await initRepo({ 'secret/a.txt': '1\n' });
    const git = new Git();
    await git.run(root, ['mv', 'secret/a.txt', 'a.txt']);
    const paths = (await git.statusPaths(root)).map((p) => p.path);
    expect(paths).toEqual(expect.arrayContaining(['a.txt', 'secret/a.txt']));
  });
});

describe('test harness integrity (#4)', () => {
  const diff = (file: string, body: string): string => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${body}\n`;
  it('flags changes to the test runner configuration and scripts, and more skip markers', () => {
    expect(analyzeTestDiff(diff('package.json', '-  "test": "vitest run",\n+  "test": "exit 0",'))[0]?.kind).toBe('harness-changed');
    expect(analyzeTestDiff(diff('package.json', '-  "version": "1.0.0",\n+  "version": "1.0.1",'))).toEqual([]);
    expect(analyzeTestDiff(diff('vitest.config.ts', '-include: [1]\n+include: []'))[0]?.kind).toBe('harness-changed');
    expect(analyzeTestDiff(diff('conftest.py', '+import pytest'))[0]?.kind).toBe('harness-changed');
    expect(analyzeTestDiff(diff('tests/a.test.ts', '+test.fixme("x", () => {})'))[0]?.kind).toBe('test-skipped');
    expect(analyzeTestDiff(diff('tests/test_a.py', '+@pytest.mark.xfail'))[0]?.kind).toBe('test-skipped');
  });
});

describe('gates cannot change what they certify (#5)', () => {
  it('a gate command that edits tracked files or moves HEAD is BLOCKED, not PASS', async () => {
    const root = await initRepo({ 'a.txt': '1\n' });
    const git = new Git();
    const { store, clock } = makeStore();
    const run = newRun(store);
    const head = await git.head(root);
    store.setFields(run.id, { headSha: head, baseCommit: head });
    const ctx: GateRunCtx = { store, runId: run.id, cwd: root, commitSha: head, policy: { allowed: [['node']] }, git, artifactDir: join(tmp(), 'a'), timeoutMs: 20000, environment: 't', clock, builtins: coreBuiltins };
    const entry = (cmd: string) => ({ gateId: 'unit', kind: 'unit' as const, required: true, command: cmd, source: 'config' as const });
    expect(await runGate(ctx, entry(`node -e "require('fs').writeFileSync('a.txt','changed')"`))).toMatchObject({ state: 'BLOCKED', failureCategory: 'gate-mutated-repo' });
    await git.run(root, ['checkout', '--', 'a.txt']);
    expect(await runGate(ctx, entry(`node -e "require('child_process').execFileSync('git',['commit','--allow-empty','-m','x'])"`))).toMatchObject({ state: 'BLOCKED', failureCategory: 'gate-mutated-repo' });
  });

  it('delivery refuses a worktree whose tip is not the verified commit', async () => {
    const e = await engineFor(await project(), agents());
    const { runId } = await approveAndRun(e);
    const run = e.d.store.getRun(runId);
    expect(run.state).toBe('PR_OPEN');
    // simulate a post-verification commit on the branch, then ask delivery to run again from REVIEW_REQUIRED
    const { stepDeliver } = await import('../src/engine/steps-deliver');
    write(run.worktreePath!, 'late.txt', 'x');
    await new Git().commitAll(run.worktreePath!, 'chore: late change');
    e.d.store.db.prepare(`UPDATE task_run SET state = 'REVIEW_REQUIRED' WHERE id = ?`).run(runId);
    await stepDeliver(e.d, runId);
    expect(e.d.store.getRun(runId).state).toBe('BLOCKED');
    expect(e.d.store.getRun(runId).blockedReason).toContain('differs from the verified commit');
  });
});

describe('redaction coverage (#8)', () => {
  it('masks database URLs, provider keys, JWTs and npm tokens', () => {
    const jwt = ['eyJhbGciOi', 'JIUzI1NiJ9', 'eyJzdWIiOiIx', 'MjM0NTY3', 'abcdefghij1234'];
    const samples = ['postgres://admin:hunter22@db.internal/app', 'redis://:pw12345@cache:6379', `DATABASE_URL=postgres://u:p@h/db`, ['sk', 'live', 'abcdefghijklmnop12'].join('_'), ['AIza', 'SyA1234567890abcdefghijklmnopqrstuv'].join(''), `${jwt[0]}${jwt[1]}.${jwt[2]}${jwt[3]}.${jwt[4]}`, ['npm', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')];
    for (const s of samples) expect(redact(`value ${s} end`), s).toContain('[REDACTED');
  });
});

const sandboxed = sandboxSupport().ok ? describe : describe.skip;
sandboxed('sandbox robustness (#9)', () => {
  it('a burst of concurrent calls cannot slip past the call limit, and garbage output cannot crash the host', async () => {
    const root = await initRepo({ 'a.txt': '1' });
    const c = new LocalToolComposer({ root });
    const burst = await c.run(`await Promise.all(Array.from({ length: 200 }, () => tools.tests.discoverSuites({}))); return 'done';`, { limits: { maxCalls: 5 } });
    expect(burst.ok).toBe(false);
    expect(burst.error).toContain('call limit of 5');
    const garbage = await c.run(`process.stdout.write('this is not json\\n'); await new Promise((r) => setTimeout(r, 2000)); return 1;`);
    expect(garbage.ok).toBe(false);
    expect(garbage.error).toContain('protocol violation');
    writeFileSync(join(root, 'noop'), '');
  });
});
