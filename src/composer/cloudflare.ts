import { z } from 'zod';
import { ToolHost, byteLen, truncateValue } from './host';
import { buildTools, type ToolDeps } from './tools';
import { type CallAudit, type ComposeOptions, type ComposeResult, DEFAULT_LIMITS, type ToolComposer, type ToolContext, type ToolDef } from './types';
import { redact } from '../shared/redact';

/**
 * Bridge to a Cloudflare Worker that runs model-written programs (for example one built on Cloudflare's experimental
 * Code Mode library). ProofLoop defines the wire contract below and enforces every tool rule on the host side; it has
 * NOT been verified against a real Cloudflare deployment, only against a local mock of this contract.
 *
 * Data flow (explicit opt-in required): the program text, the tool schemas AND the results of every tool call are sent
 * to the Worker, because the program runs there and processes those results. Repository contents therefore leave the
 * machine. Set PROOFLOOP_CODEMODE_CLOUDFLARE=1, PROOFLOOP_CODEMODE_CF_URL (https), PROOFLOOP_CODEMODE_CF_TOKEN and
 * PROOFLOOP_CODEMODE_CF_ACK_DATA_FLOW=1 to enable. The core protocols never depend on it.
 *
 *   POST {url}/run     { program, tools:[{name,mode,description,input}], limits } -> { session, event }
 *   POST {url}/resume  { session, id, ok:true, value } | { session, id, ok:false, error }  -> { event }
 *   event = { type:'call', id, name, args } | { type:'done', value } | { type:'error', message }
 */
const wire = z.object({ session: z.string().optional(), event: z.discriminatedUnion('type', [z.object({ type: z.literal('call'), id: z.union([z.number(), z.string()]), name: z.string(), args: z.unknown() }), z.object({ type: z.literal('done'), value: z.unknown() }), z.object({ type: z.literal('error'), message: z.string() })]) });

export interface CloudflareOptions {
  ctx?: ToolContext;
  deps?: ToolDeps;
  tools?: ToolDef[];
  fetch?: typeof fetch;
  onAudit?: (c: CallAudit) => void;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Reads a response body but gives up past `max` bytes, so a hostile Worker cannot exhaust host memory. */
async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error(`worker response exceeded ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])$/;

export class CloudflareToolComposer implements ToolComposer {
  readonly name = 'cloudflare-codemode';
  private readonly tools: Map<string, ToolDef>;
  private readonly host: ToolHost;
  private readonly doFetch: typeof fetch;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly opts: CloudflareOptions = {},
  ) {
    this.tools = new Map((opts.tools ?? buildTools(opts.deps)).map((t) => [t.name, t]));
    this.host = new ToolHost(this.tools, opts.ctx ?? { root: process.cwd() }, opts.onAudit ?? (() => undefined));
    this.doFetch = opts.fetch ?? fetch;
  }

  available(): { ok: boolean; reason?: string } {
    const e = this.env;
    if (e.PROOFLOOP_CODEMODE_CLOUDFLARE !== '1') return { ok: false, reason: 'disabled (set PROOFLOOP_CODEMODE_CLOUDFLARE=1 to opt in; upstream Code Mode is experimental)' };
    if (e.PROOFLOOP_CODEMODE_CF_ACK_DATA_FLOW !== '1') return { ok: false, reason: 'set PROOFLOOP_CODEMODE_CF_ACK_DATA_FLOW=1 to acknowledge that program text, tool schemas and tool results (repository content) are sent to your Worker' };
    let url: URL;
    try {
      url = new URL(e.PROOFLOOP_CODEMODE_CF_URL ?? '');
    } catch {
      return { ok: false, reason: 'PROOFLOOP_CODEMODE_CF_URL must be the URL of your Worker' };
    }
    const local = LOCAL_HOST.test(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return { ok: false, reason: 'the Worker URL must be https (plain http is only accepted for localhost)' };
    if (!local && !e.PROOFLOOP_CODEMODE_CF_TOKEN) return { ok: false, reason: 'PROOFLOOP_CODEMODE_CF_TOKEN is required for a remote Worker' };
    return { ok: true };
  }

  describeTools() {
    return [...this.tools.values()].map((t) => ({ name: t.name, mode: t.mode, description: t.description, input: z.toJSONSchema(t.input) as object, output: t.output }));
  }

  private async post(path: string, body: unknown, signal: AbortSignal): Promise<z.infer<typeof wire>> {
    const base = this.env.PROOFLOOP_CODEMODE_CF_URL!.replace(/\/$/, '');
    const res = await this.doFetch(`${base}${path}`, { method: 'POST', signal, redirect: 'error', headers: { 'content-type': 'application/json', ...(this.env.PROOFLOOP_CODEMODE_CF_TOKEN ? { authorization: `Bearer ${this.env.PROOFLOOP_CODEMODE_CF_TOKEN}` } : {}) }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`worker responded ${res.status}`);
    return wire.parse(JSON.parse(await readCapped(res, MAX_RESPONSE_BYTES)));
  }

  async run(program: string, o: ComposeOptions = {}): Promise<ComposeResult> {
    const started = Date.now();
    const calls: CallAudit[] = [];
    const limits = { ...DEFAULT_LIMITS, ...o.limits };
    let bytesIn = 0;
    const fail = (error: string): ComposeResult => ({ ok: false, error: redact(error), calls, durationMs: Date.now() - started, bytesIn, bytesOut: 0 });
    const a = this.available();
    if (!a.ok) return fail(`cloudflare adapter unavailable: ${a.reason}`);
    try {
      new (Object.getPrototypeOf(async function () {}).constructor)('tools', program);
    } catch (e) {
      return fail(`program rejected: ${e instanceof Error ? e.message : String(e)}`);
    }
    const signal = AbortSignal.any([AbortSignal.timeout(limits.maxDurationMs), ...(o.signal ? [o.signal] : [])]);
    const received = { n: 0 };
    try {
      let step = await this.post('/run', { program, tools: this.describeTools(), limits: { maxCalls: limits.maxCalls, maxDurationMs: limits.maxDurationMs } }, signal);
      const session = step.session;
      for (;;) {
        const ev = step.event;
        if (ev.type === 'error') return fail(ev.message);
        if (ev.type === 'done') {
          const cut = truncateValue(ev.value ?? null, limits.maxResultBytes);
          return { ok: true, value: cut.value, calls, durationMs: Date.now() - started, bytesIn, bytesOut: byteLen(cut.value) };
        }
        const out = await this.host.call(ev.name, ev.args, { limits, writes: new Set(o.allowWrites ?? []), calls, addBytesIn: (n) => (bytesIn += n), received });
        if ('violation' in out) return fail(out.violation);
        step = await this.post('/resume', { session, id: ev.id, ...out.reply }, signal);
      }
    } catch (e) {
      return fail(signal.aborted ? (o.signal?.aborted ? 'cancelled' : `time limit of ${limits.maxDurationMs}ms exceeded`) : e instanceof Error ? e.message : String(e));
    }
  }
}

export function createComposer(kind: 'local' | 'cloudflare', make: () => ToolComposer, env: NodeJS.ProcessEnv = process.env): ToolComposer {
  return kind === 'cloudflare' ? new CloudflareToolComposer(env) : make();
}
