import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { RUNNER_SOURCE } from './runner-source';
import { buildTools, type ToolDeps } from './tools';
import { type CallAudit, type ComposeOptions, type ComposeResult, DEFAULT_LIMITS, type ToolComposer, type ToolContext, type ToolDef } from './types';
import { redact } from '../shared/redact';

/** The sandbox needs Node's permission model including network denial (Node 25+); otherwise it refuses to run. */
export function sandboxSupport(): { ok: boolean; reason?: string } {
  const flags = process.allowedNodeEnvironmentFlags;
  if (!flags.has('--permission')) return { ok: false, reason: `Node ${process.version} lacks --permission` };
  if (!flags.has('--allow-net')) return { ok: false, reason: `Node ${process.version} cannot deny network access to the sandbox; use Node >= 25. Core protocols are unaffected.` };
  return { ok: true };
}

const byteLen = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '');

function truncateValue(v: unknown, max: number): { value: unknown; truncated: boolean } {
  const s = JSON.stringify(v) ?? 'null';
  if (Buffer.byteLength(s) <= max) return { value: v, truncated: false };
  return { value: `${s.slice(0, max)}…[truncated]`, truncated: true };
}

export class LocalToolComposer implements ToolComposer {
  readonly name = 'local-sandbox';
  private readonly tools: Map<string, ToolDef>;
  constructor(
    private readonly ctx: ToolContext,
    deps: ToolDeps & { tools?: ToolDef[]; audit?: (call: CallAudit) => void } = {},
    private readonly onAudit: (call: CallAudit) => void = deps.audit ?? (() => undefined),
  ) {
    this.tools = new Map((deps.tools ?? buildTools(deps)).map((t) => [t.name, t]));
  }

  available(): { ok: boolean; reason?: string } {
    return sandboxSupport();
  }

  describeTools() {
    return [...this.tools.values()].map((t) => ({ name: t.name, mode: t.mode, description: t.description, input: z.toJSONSchema(t.input) as object, output: t.output }));
  }

  async run(program: string, opts: ComposeOptions = {}): Promise<ComposeResult> {
    const started = Date.now();
    const limits = { ...DEFAULT_LIMITS, ...opts.limits };
    const support = this.available();
    const calls: CallAudit[] = [];
    const fail = (error: string, bytesIn = 0): ComposeResult => ({ ok: false, error, calls, durationMs: Date.now() - started, bytesIn, bytesOut: 0 });
    if (!support.ok) return fail(`sandbox unavailable: ${support.reason}`);
    if (program.length > 20_000) return fail('program rejected: longer than 20,000 characters');
    try {
      new (Object.getPrototypeOf(async function () {}).constructor)('tools', program);
    } catch (e) {
      return fail(`program rejected: ${e instanceof Error ? e.message : String(e)}`);
    }
    return this.execute(program, limits, new Set(opts.allowWrites ?? []), calls, started, opts.signal);
  }

  private async execute(program: string, limits: typeof DEFAULT_LIMITS, writes: Set<string>, calls: CallAudit[], started: number, signal?: AbortSignal): Promise<ComposeResult> {
    // the permission model matches real paths; /var -> /private/var on macOS would otherwise be denied
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pl-sbx-')));
    const file = join(dir, 'runner.mjs');
    writeFileSync(file, RUNNER_SOURCE, { mode: 0o600 });
    chmodSync(file, 0o600);
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${dir}`, '--disable-warning=ExperimentalWarning', file], { env: {}, stdio: ['pipe', 'pipe', 'pipe'], cwd: dir });
    let bytesIn = 0;
    type Verdict = { ok: true; value: unknown } | { ok: false; error: string };
    const box: { verdict: Verdict | null } = { verdict: null };
    const kill = (error: string): void => {
      box.verdict ??= { ok: false, error };
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill(`time limit of ${limits.maxDurationMs}ms exceeded`), limits.maxDurationMs);
    signal?.addEventListener('abort', () => kill('cancelled'));
    let stderrText = '';
    child.stderr.on('data', (d: Buffer) => void (stderrText += d.toString().slice(0, 2000)));
    let stdoutBytes = 0;
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > limits.maxResultBytes * 8 + 1024 * 1024) return kill('sandbox output limit exceeded');
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        void this.onMessage(JSON.parse(line) as Record<string, unknown>, child, limits, writes, calls, (n) => (bytesIn += n), kill, (v) => void (box.verdict ??= v));
      }
    });
    child.stdin.write(`${JSON.stringify({ type: 'program', code: program, tools: [...this.tools.keys()] })}\n`);
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
    const v: Verdict = box.verdict ?? { ok: false, error: `sandbox exited without a result${stderrText ? `: ${stderrText.split('\n').find((l) => l.trim()) ?? ''}` : ''}` };
    if (!v.ok) return { ok: false, error: redact(v.error), calls, durationMs: Date.now() - started, bytesIn, bytesOut: 0 };
    const cut = truncateValue(v.value, limits.maxResultBytes);
    return { ok: true, value: cut.value, calls, durationMs: Date.now() - started, bytesIn, bytesOut: byteLen(cut.value) };
  }

  private async onMessage(msg: Record<string, unknown>, child: ReturnType<typeof spawn>, limits: typeof DEFAULT_LIMITS, writes: Set<string>, calls: CallAudit[], addIn: (n: number) => void, kill: (e: string) => void, setVerdict: (v: { ok: true; value: unknown } | { ok: false; error: string }) => void): Promise<void> {
    if (msg.type === 'done') return setVerdict({ ok: true, value: msg.value });
    if (msg.type === 'error') return setVerdict({ ok: false, error: String(msg.message) });
    if (msg.type !== 'call') return;
    const id = msg.id as number;
    const reply = (m: object): void => void child.stdin?.write(`${JSON.stringify({ type: 'result', id, ...m })}\n`);
    if (calls.length >= limits.maxCalls) return kill(`call limit of ${limits.maxCalls} exceeded`);
    const name = String(msg.name);
    const t0 = Date.now();
    const audit = (a: Omit<CallAudit, 'tool' | 'ms'>): void => {
      const rec = { tool: name, ms: Date.now() - t0, ...a };
      calls.push(rec);
      this.onAudit(rec);
    };
    const tool = this.tools.get(name);
    if (!tool) return (audit({ ok: false, bytes: 0, truncated: false, denied: 'unknown tool' }), reply({ ok: false, error: `unknown tool ${name}` }));
    if (tool.mode === 'write' && !writes.has(name)) return (audit({ ok: false, bytes: 0, truncated: false, denied: 'write not permitted' }), reply({ ok: false, error: `${name} is a mutating tool and was not authorized for this run` }));
    const parsed = tool.input.safeParse(msg.args);
    if (!parsed.success) return (audit({ ok: false, bytes: 0, truncated: false, denied: 'invalid input' }), reply({ ok: false, error: `invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` }));
    try {
      const out = await Promise.race([tool.handler(parsed.data, this.ctx), new Promise<never>((_r, rej) => setTimeout(() => rej(new Error(`${name} timed out`)), tool.timeoutMs))]);
      const cut = truncateValue(out, tool.maxOutputBytes);
      const bytes = byteLen(cut.value);
      addIn(bytes);
      audit({ ok: true, bytes, truncated: cut.truncated });
      reply({ ok: true, value: cut.value });
    } catch (e) {
      audit({ ok: false, bytes: 0, truncated: false, denied: 'handler error' });
      reply({ ok: false, error: redact(e instanceof Error ? e.message : String(e)) });
    }
  }
}
