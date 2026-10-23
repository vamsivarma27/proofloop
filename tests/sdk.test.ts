import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ScriptedRuntime } from '../src/agent/runtime';
import { CloudflareToolComposer } from '../src/composer/cloudflare';
import { LocalToolComposer } from '../src/composer/local';
import { GhAdapter } from '../src/github/adapter';
import { SqliteQueryPlanAdapter } from '../src/perf/queryplan';
import { loadRegistry, parseProtocol } from '../src/protocol/registry';
import { agentRuntimeContract, githubPortContract, queryPlanContract, toolComposerContract, type Assert } from '../src/sdk/contracts';
import type { Exec, ExecResult } from '../src/shared/exec';
import { approveAndRun, agents, engineFor, project } from './engine-helpers';
import { initRepo } from './repo-helpers';

const assert: Assert = {
  ok: (v, m) => expect(Boolean(v), m).toBe(true),
  equal: (a, b, m) => expect(a, m).toEqual(b),
};

describe('shipped protocol examples (v0.7)', () => {
  it('all validate against the schema and the running engine version', () => {
    const dir = join(process.cwd(), 'examples', 'protocols');
    const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBe(4);
    for (const f of files) expect(parseProtocol(readFileSync(join(dir, f), 'utf8'), f).diagnostics, f).toEqual([]);
  });

  it('a contributor can add a protocol without touching the engine: it loads from .proofloop/protocols and runs', async () => {
    const root = await project();
    mkdirSync(join(root, '.proofloop', 'protocols'), { recursive: true });
    writeFileSync(join(root, '.proofloop', 'protocols', 'team-change.yaml'), readFileSync(join('examples', 'protocols', 'generic-change.yaml'), 'utf8').replace('id: generic-change', 'id: team-change'));
    const e = await engineFor(root, agents());
    expect(e.d.registry.list().map((p) => p.id)).toContain('team-change');
    const run = await e.start({ protocolId: 'team-change', intent: 'Add the feature file' });
    const out = await e.drive(run.id);
    expect(out).toMatchObject({ state: 'AWAITING_APPROVAL', waiting: 'approval' });
    expect(e.d.store.getRun(run.id).protocolId).toBe('team-change');
  });

  it('invalid custom protocols fail with actionable diagnostics and never replace built-ins', async () => {
    const root = await project();
    mkdirSync(join(root, '.proofloop', 'protocols'), { recursive: true });
    writeFileSync(join(root, '.proofloop', 'protocols', 'bad.yaml'), 'schemaVersion: 1\nid: feature\nversion: 9.9.9\n');
    writeFileSync(join(root, '.proofloop', 'protocols', 'dup.yaml'), readFileSync('protocols/feature.yaml', 'utf8'));
    const reg = loadRegistry(root);
    expect(reg.get('feature').version).toBe('1.0.0');
    const msgs = reg.diagnostics.map((d) => `${d.path}: ${d.message}`).join('\n');
    expect(msgs).toContain('already registered');
    expect(reg.diagnostics.every((d) => d.file && d.path && d.message)).toBe(true);
  });

  it('pins protocol and plugin versions in task evidence', async () => {
    const e = await engineFor(await project(), agents());
    const { runId } = await approveAndRun(e);
    const pinned = e.d.store.events(runId, 'protocol.pinned')[0]!.data;
    expect(pinned).toMatchObject({ id: 'feature', version: '1.0.0', engine: '1.0.0-rc.2' });
    expect(String(pinned.sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(e.report(runId)).toMatch(/Protocol: feature@1\.0\.0 \(sha256 [0-9a-f]{12}\), plugin\/engine 1\.0\.0-rc\.2/);
  });
});

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false });

describe('adapter contract suite runs against the built-in adapters (CI gate)', () => {
  it('GithubPort: GhAdapter over a faithful gh fake', async () => {
    const issues: Array<{ n: number; body: string }> = [];
    const exec: Exec = async (_c, args) => {
      const a = args.join(' ');
      if (a === 'api user --jq .login') return ok('me');
      if (args[3] === 'search/issues') {
        const m = /proofloop:key=([^"]+)"/.exec(args.find((x) => x.startsWith('q='))!);
        if (!m) return ok(''); // a plain history search: nothing matches
        const key = m[1]!;
        return ok(issues.filter((i) => i.body.includes(`key=${key} `)).map((i) => JSON.stringify([i.n, `N${i.n}`, `u${i.n}`, i.body])).join('\n'));
      }
      if (args[1] === 'repos/o/r/issues') { const n = issues.length + 1; issues.push({ n, body: args.find((x) => x.startsWith('body='))! }); return ok(JSON.stringify([n, `N${n}`, `https://x/${n}`])); }
      if (a.includes('--paginate')) return ok('');
      return ok();
    };
    await githubPortContract(() => new GhAdapter('o/r', exec), assert);
  });

  it('AgentRuntime: ScriptedRuntime', async () => {
    await agentRuntimeContract(() => new ScriptedRuntime(() => ({ text: 'hello' })), assert, process.cwd());
  });

  it('ToolComposer: local sandbox and the disabled Cloudflare adapter both fail closed', async () => {
    const root = await initRepo({ 'a.txt': '1' });
    await toolComposerContract(() => new LocalToolComposer({ root }), assert);
    await toolComposerContract(() => new CloudflareToolComposer({}), assert);
  });

  it('QueryPlanAdapter: SQLite', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pl-sdk-')), 'x.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.close();
    queryPlanContract(() => new SqliteQueryPlanAdapter(path), 'SELECT * FROM t WHERE v = 1', assert);
  });

  it('a deliberately broken adapter is caught by the contract', async () => {
    const broken = { preflight: async () => ({ ok: true, repo: null, problems: [], canWrite: true }), ensureIssue: async () => ({ number: Math.random(), nodeId: 'n', url: 'u' }), addCheckpoint: async () => undefined, linkSubIssue: async () => 'linked' as const, blockedBy: async () => 'linked' as const, openPullRequest: async () => 'x', getIssue: async () => ({ number: 1, title: '', body: '', state: '' }), getPullRequest: async () => ({ state: 'OPEN' as const, checks: 'none' as const }) };
    await expect(githubPortContract(() => broken, assert)).rejects.toThrow();
  });
});
