import { FAKE_GH_TOKEN } from './fake-secrets';
import { describe, expect, it } from 'vitest';
import { GhAdapter, GithubSync, type GithubPort, type IssueRef, marker } from '../src/github/adapter';
import type { Exec, ExecResult } from '../src/shared/exec';
import { makeStore, newRun } from './helpers';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false });
const err = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr, timedOut: false, truncated: false });

/** A tiny fake GitHub behind the gh CLI surface the adapter uses. */
function fakeGh() {
  const issues: Array<{ number: number; node_id: string; html_url: string; body: string; title: string }> = [];
  const comments: string[] = [];
  const calls: string[][] = [];
  let down = false;
  const exec: Exec = async (cmd, args) => {
    calls.push([...args]);
    if (cmd !== 'gh') return err('not gh');
    if (down) return err('connection refused');
    const a = args.join(' ');
    if (a.startsWith('auth status')) return ok();
    if (a.startsWith('repo view')) return ok('o/r\tADMIN');
    if (args[0] === 'api' && args[1] === '-X' && args[3] === 'search/issues') {
      const q = args.find((x) => x.startsWith('q='))!;
      const key = /proofloop:key=([^"]+)"/.exec(q)![1]!;
      return ok(issues.filter((i) => i.body.includes(`key=${key} `)).map((i) => JSON.stringify([i.number, i.node_id, i.html_url, i.body])).join('\n'));
    }
    if (args[0] === 'api' && args[1] === 'repos/o/r/issues') {
      const get = (k: string): string => args.find((x) => x.startsWith(`${k}=`))!.slice(k.length + 1);
      const n = issues.length + 1;
      issues.push({ number: n, node_id: `N${n}`, html_url: `https://github.com/o/r/issues/${n}`, body: get('body'), title: get('title') });
      return ok(JSON.stringify([n, `N${n}`, `https://github.com/o/r/issues/${n}`]));
    }
    if (/issues\/\d+\/comments/.test(a) && a.includes('--paginate')) return ok(comments.join('\n'));
    if (/issues\/\d+\/comments/.test(a)) {
      comments.push(args.find((x) => x.startsWith('body='))!);
      return ok();
    }
    if (a.includes('graphql')) return a.includes('addBlockedBy') ? err('Field "addBlockedBy" doesn\'t exist on type Mutation') : ok();
    if (a.startsWith('pr list')) return ok('');
    if (a.startsWith('pr create')) return ok('https://github.com/o/r/pull/9');
    return err(`unexpected: ${a}`);
  };
  return { exec, issues, comments, calls, setDown: (v: boolean) => (down = v) };
}

describe('GhAdapter (contract, mocked gh)', () => {
  it('preflight reports permission and auth problems', async () => {
    const g = fakeGh();
    expect(await new GhAdapter('o/r', g.exec).preflight()).toMatchObject({ ok: true, canWrite: true });
    g.setDown(true);
    const bad = await new GhAdapter('o/r', g.exec).preflight();
    expect(bad.ok).toBe(false);
    expect(bad.problems.length).toBeGreaterThan(0);
  });

  it('reports a missing gh binary clearly', async () => {
    const exec: Exec = async () => ({ code: null, stdout: '', stderr: '', timedOut: false, truncated: false, spawnError: 'ENOENT' });
    expect((await new GhAdapter('o/r', exec).preflight()).problems).toEqual(['gh CLI not installed']);
  });

  it('ensureIssue is idempotent by marker and redacts the body (AC1)', async () => {
    const g = fakeGh();
    const gh = new GhAdapter('o/r', g.exec);
    const a = await gh.ensureIssue('run/1', 'T', `token ${FAKE_GH_TOKEN}`);
    const b = await gh.ensureIssue('run/1', 'T', 'again');
    expect(b.number).toBe(a.number);
    expect(g.issues.length).toBe(1);
    expect(g.issues[0]!.body).toContain(marker('run/1'));
    expect(g.issues[0]!.body).not.toContain('ghp_abc');
    await gh.ensureIssue('run/2', 'U', 'b');
    expect(g.issues.length).toBe(2);
  });

  it('checkpoints are deduped by key', async () => {
    const g = fakeGh();
    const gh = new GhAdapter('o/r', g.exec);
    const issue = await gh.ensureIssue('run/1', 'T', 'b');
    await gh.addCheckpoint(issue, 'cp/1', 'plan approved');
    await gh.addCheckpoint(issue, 'cp/1', 'plan approved');
    expect(g.comments.length).toBe(1);
  });

  it('degrades gracefully when sub-issue/dependency mutations are unsupported', async () => {
    const g = fakeGh();
    const gh = new GhAdapter('o/r', g.exec);
    const [p, c]: IssueRef[] = [await gh.ensureIssue('p', 'P', 'b'), await gh.ensureIssue('c', 'C', 'b')] as [IssueRef, IssueRef];
    expect(await gh.linkSubIssue(p, c)).toBe('linked');
    expect(await gh.blockedBy(c, p)).toBe('unsupported');
  });

  it('opens a PR once', async () => {
    const g = fakeGh();
    expect(await new GhAdapter('o/r', g.exec).openPullRequest({ head: 'h', base: 'b', title: 't', body: 'x', cwd: '.' })).toBe('https://github.com/o/r/pull/9');
  });
});

describe('GithubSync (durable, honest about outages)', () => {
  it('creates exactly one parent issue even when called repeatedly', async () => {
    const g = fakeGh();
    const { store } = makeStore();
    const run = newRun(store);
    const sync = new GithubSync(store, new GhAdapter('o/r', g.exec));
    const a = await sync.ensureParent(run.id, 'T', 'B');
    const b = await sync.ensureParent(run.id, 'T', 'B');
    expect(a).toMatchObject({ status: 'synced' });
    expect(b).toMatchObject({ status: 'synced' });
    expect(g.issues.length).toBe(1);
    expect(store.getRun(run.id).sourceIssueNumber).toBe(1);
    expect(store.getRun(run.id).sourceIssueId).toBe('N1');
  });

  it('survives lost local state: a new store finds the issue by marker instead of duplicating', async () => {
    const g = fakeGh();
    const one = makeStore();
    const run = newRun(one.store);
    await new GithubSync(one.store, new GhAdapter('o/r', g.exec)).ensureParent(run.id, 'T', 'B');
    const two = makeStore();
    await new GithubSync(two.store, new GhAdapter('o/r', g.exec)).ensureParent(run.id, 'T', 'B').catch(() => undefined);
    expect(g.issues.length).toBe(1);
  });

  it('queues when GitHub is down, reports queued (never synced), and flushes later without duplicates', async () => {
    const g = fakeGh();
    const { store } = makeStore();
    const run = newRun(store);
    const sync = new GithubSync(store, new GhAdapter('o/r', g.exec));
    g.setDown(true);
    expect(await sync.ensureParent(run.id, 'T', 'B')).toEqual({ status: 'queued' });
    expect(await sync.checkpoint(run.id, 'planned', 'plan ready')).toBe('queued');
    expect(store.pendingOutbox().length).toBe(2);
    expect(await sync.flush()).toEqual({ done: 0, pending: 2 });
    g.setDown(false);
    const r = await sync.flush();
    expect(r.pending).toBe(0);
    expect(g.issues.length).toBe(1);
    expect(g.comments.length).toBe(1);
    expect((await sync.flush()).done).toBe(0);
    expect(g.comments.length).toBe(1);
  });

  it('is a no-op (disabled) without a port', async () => {
    const { store } = makeStore();
    const run = newRun(store);
    const sync = new GithubSync(store, null);
    expect(await sync.ensureParent(run.id, 'T', 'B')).toEqual({ status: 'disabled' });
    expect(await sync.checkpoint(run.id, 'x', 'y')).toBe('disabled');
    expect(sync.enabled).toBe(false);
  });

  it('accepts any GithubPort (replaceable adapter)', async () => {
    const port: GithubPort = {
      preflight: async () => ({ ok: true, repo: 'x/y', problems: [], canWrite: true }),
      ensureIssue: async () => ({ number: 7, nodeId: 'X', url: 'u' }),
      addCheckpoint: async () => undefined,
      linkSubIssue: async () => 'unsupported',
      blockedBy: async () => 'unsupported',
      openPullRequest: async () => 'pr',
      getIssue: async () => ({ number: 7, title: '', body: '', state: 'open' }),
      getPullRequest: async () => ({ state: 'OPEN', checks: 'none' }),
    };
    const { store } = makeStore();
    const run = newRun(store);
    expect(await new GithubSync(store, port).ensureParent(run.id, 't', 'b')).toMatchObject({ status: 'synced' });
  });
});
