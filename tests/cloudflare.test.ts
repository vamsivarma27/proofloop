import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudflareToolComposer } from '../src/composer/cloudflare';
import type { GithubPort } from '../src/github/adapter';
import { toolComposerContract, type Assert } from '../src/sdk/contracts';
import { makeStore, newRun } from './helpers';
import { initRepo } from './repo-helpers';
import { expect as ex } from 'vitest';

type Ev = { type: 'call'; id: number; name: string; args: unknown } | { type: 'done'; value: unknown } | { type: 'error'; message: string };

/** A local stand-in for the Worker contract (NOT Cloudflare): runs the program in-process and bridges tool calls. */
function mockWorker(opts: { hang?: boolean; status?: number } = {}) {
  const sessions = new Map<string, { queue: Ev[]; waiter: ((e: Ev) => void) | null; resolvers: Map<number, { ok: (v: unknown) => void; err: (e: Error) => void }> }>();
  const received: { path: string; body: Record<string, unknown> }[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      received.push({ path: req.url ?? '', body });
      if (opts.status) return void res.writeHead(opts.status).end('no');
      if (opts.hang) return;
      const respond = (session: string, ev: Ev): void => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ session, event: ev }));
      const nextEvent = (id: string): Promise<Ev> => new Promise((resolve) => { const s = sessions.get(id)!; const q = s.queue.shift(); if (q) resolve(q); else s.waiter = resolve; });
      if (req.url === '/run') {
        const id = `s${++n}`;
        const s = { queue: [] as Ev[], waiter: null as ((e: Ev) => void) | null, resolvers: new Map<number, { ok: (v: unknown) => void; err: (e: Error) => void }>() };
        sessions.set(id, s);
        const emit = (e: Ev): void => {
          if (s.waiter) {
            const w = s.waiter;
            s.waiter = null;
            w(e);
          } else s.queue.push(e);
        };
        let callId = 0;
        const tools: Record<string, Record<string, (a: unknown) => Promise<unknown>>> = {};
        for (const t of body.tools as Array<{ name: string }>) {
          const [ns, fn] = t.name.split('.') as [string, string];
          (tools[ns] ??= {})[fn] = (args) => new Promise((ok, err) => { const cid = ++callId; s.resolvers.set(cid, { ok, err: (e) => err(e) }); emit({ type: 'call', id: cid, name: t.name, args }); });
        }
        const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
        new AsyncFn('tools', body.program as string)(tools).then((v: unknown) => emit({ type: 'done', value: v ?? null }), (e: Error) => emit({ type: 'error', message: e.message }));
        return respond(id, await nextEvent(id));
      }
      const s = sessions.get(body.session as string)!;
      const r = s.resolvers.get(body.id as number)!;
      if (body.ok) r.ok(body.value);
      else r.err(new Error(String(body.error)));
      respond(body.session as string, await nextEvent(body.session as string));
    });
  });
  return new Promise<{ url: string; received: typeof received; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, received, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) })),
  );
}

const ENV = (url: string): NodeJS.ProcessEnv => ({ PROOFLOOP_CODEMODE_CLOUDFLARE: '1', PROOFLOOP_CODEMODE_CF_ACK_DATA_FLOW: '1', PROOFLOOP_CODEMODE_CF_URL: url });
let closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.map((c) => c())); closers = []; });
const start = async (o: Parameters<typeof mockWorker>[0] = {}) => { const m = await mockWorker(o); closers.push(m.close); return m; };

describe('Cloudflare bridge: enablement is explicit and data flow is acknowledged', () => {
  it('requires the flag, the data-flow acknowledgement, a valid https URL and a token for remote Workers', () => {
    const reason = (env: NodeJS.ProcessEnv) => new CloudflareToolComposer(env).available().reason ?? 'ok';
    expect(reason({})).toContain('disabled');
    expect(reason({ PROOFLOOP_CODEMODE_CLOUDFLARE: '1' })).toContain('ACK_DATA_FLOW');
    expect(reason({ PROOFLOOP_CODEMODE_CLOUDFLARE: '1', PROOFLOOP_CODEMODE_CF_ACK_DATA_FLOW: '1' })).toContain('CF_URL');
    expect(reason({ ...ENV('http://worker.example.com') })).toContain('https');
    expect(reason({ ...ENV('https://worker.example.com') })).toContain('TOKEN');
    expect(reason({ ...ENV('https://worker.example.com'), PROOFLOOP_CODEMODE_CF_TOKEN: 't' })).toBe('ok');
    expect(reason(ENV('http://127.0.0.1:9'))).toBe('ok');
  });
});

describe('Cloudflare bridge against a local mock of the contract (not Cloudflare)', () => {
  const make = async (env: NodeJS.ProcessEnv, deps = {}) => new CloudflareToolComposer(env, { ctx: { root: await initRepo({ 'src/a.ts': 'export function pagination() {}\n', 'src/b.ts': 'x', '.env': 'S=1' }) }, deps });

  it('composes tools, enforces host-side rules, and reports what leaves the machine', async () => {
    const w = await start();
    const c = await make(ENV(w.url));
    const r = await c.run(`const f = await tools.repo.findRelevantFiles({ keywords: ['pagination'], limit: 3 }); const t = await tools.repo.readFileRange({ path: f[0].path, start: 1, end: 1 }); return { path: f[0].path, line: t.text };`);
    expect(r.ok, r.error).toBe(true);
    expect(r.value).toMatchObject({ path: 'src/a.ts', line: 'export function pagination() {}' });
    expect(r.calls.map((x) => x.tool)).toEqual(['repo.findRelevantFiles', 'repo.readFileRange']);
    // documented data flow: tool RESULTS are sent to the Worker
    expect(JSON.stringify(w.received.filter((x) => x.path === '/resume').map((x) => x.body))).toContain('export function pagination');
    expect(w.received[0]!.body).toHaveProperty('tools');
  });

  it('applies the same policy as the local sandbox: secret reads, invalid input, unauthorized writes and call limits', async () => {
    const w = await start();
    const c = await make(ENV(w.url));
    const sec = await c.run(`try { await tools.repo.readFileRange({ path: '.env' }); return 'READ'; } catch (e) { return e.message; }`);
    expect(JSON.stringify(sec.value)).toContain('denied');
    expect(JSON.stringify(sec.value)).not.toContain('S=1');
    const invalid = await c.run(`await tools.repo.readFileRange({ path: 42 }); return 1;`);
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain('invalid input for repo.readFileRange');
    const { store } = makeStore();
    const run = newRun(store);
    store.putKey(`issue:${run.id}`, JSON.stringify({ number: 1, nodeId: 'N', url: 'u' }));
    const posted: string[] = [];
    const port = { addCheckpoint: async (_i: unknown, _k: string, body: string) => void posted.push(body) } as unknown as GithubPort;
    const w2 = await start();
    const cw = new CloudflareToolComposer(ENV(w2.url), { ctx: { root: process.cwd(), runId: run.id }, deps: { store, port } });
    const denied = await cw.run(`await tools.github.addCheckpoint({ key: 'x', body: 'hi' }); return 1;`);
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('not authorized');
    expect(posted).toEqual([]);
    expect((await cw.run(`await tools.github.addCheckpoint({ key: 'x', body: 'hi' }); return 1;`, { allowWrites: ['github.addCheckpoint'] })).ok).toBe(true);
    expect(posted).toEqual(['hi']);
  });

  it('fails closed on worker errors, bad statuses, time limits and call bursts', async () => {
    const w = await start();
    expect((await (await make(ENV(w.url))).run(`throw new Error('boom');`)).error).toBe('boom');
    expect((await (await make(ENV(w.url))).run('this is not javascript (')).error).toContain('program rejected');
    const bad = await start({ status: 500 });
    expect((await (await make(ENV(bad.url))).run('return 1')).error).toContain('worker responded 500');
    const hang = await start({ hang: true });
    expect((await (await make(ENV(hang.url))).run('return 1', { limits: { maxDurationMs: 300 } })).error).toContain('time limit');
    const w3 = await start();
    const limited = await (await make(ENV(w3.url))).run(`for (let i = 0; i < 50; i++) await tools.tests.discoverSuites({}); return 1;`, { limits: { maxCalls: 3 } });
    expect(limited.error).toContain('call limit of 3');
  });

  it('refuses redirects and oversized worker responses (review #2, #3)', async () => {
    const { createServer } = await import('node:http');
    const evil = createServer((_q, res) => void res.writeHead(307, { location: 'http://127.0.0.1:1/steal' }).end());
    const big = createServer((_q, res) => void res.writeHead(200, { 'content-type': 'application/json' }).end(`{"session":"s","event":{"type":"done","value":"${'x'.repeat(2 * 1024 * 1024)}"}}`));
    await Promise.all([evil, big].map((sv) => new Promise<void>((r) => sv.listen(0, '127.0.0.1', () => r()))));
    closers.push(async () => void (evil.close(), big.close(), evil.closeAllConnections(), big.closeAllConnections()));
    const url = (sv: typeof evil): string => `http://127.0.0.1:${(sv.address() as { port: number }).port}`;
    const r1 = await (await make(ENV(url(evil)))).run('return 1');
    expect(r1.ok).toBe(false);
    const r2 = await (await make(ENV(url(big)))).run('return 1');
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('exceeded');
  });

  it('concurrent runs on one composer do not reset each other\'s call counter (review #8)', async () => {
    const w = await start();
    const c = await make(ENV(w.url));
    const prog = `for (let i = 0; i < 4; i++) await tools.tests.discoverSuites({}); return 1;`;
    const [a, b] = await Promise.all([c.run(prog, { limits: { maxCalls: 5 } }), c.run(prog, { limits: { maxCalls: 5 } })]);
    expect(a.ok && b.ok).toBe(true);
  });

  it('satisfies the ToolComposer contract, enabled and disabled', async () => {
    const assert: Assert = { ok: (v, m) => ex(Boolean(v), m).toBe(true), equal: (a, b, m) => ex(a, m).toEqual(b) };
    const w = await start();
    await toolComposerContract(() => new CloudflareToolComposer(ENV(w.url)), assert);
    await toolComposerContract(() => new CloudflareToolComposer({}), assert);
  });
});
