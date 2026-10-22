import { redact } from '../shared/redact';
import type { CallAudit, ComposerLimits, ToolContext, ToolDef } from './types';

export const byteLen = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '');

export function truncateValue(v: unknown, max: number): { value: unknown; truncated: boolean } {
  const s = JSON.stringify(v) ?? 'null';
  if (Buffer.byteLength(s) <= max) return { value: v, truncated: false };
  return { value: `${Buffer.from(s).subarray(0, max).toString()}…[truncated]`, truncated: true }; // bytes, not characters
}

export type HostReply = { ok: true; value: unknown } | { ok: false; error: string };

export interface RunState {
  limits: ComposerLimits;
  writes: ReadonlySet<string>;
  calls: CallAudit[];
  addBytesIn(n: number): void;
  /** per-run call counter; shared state on the host would let concurrent runs reset each other */
  received: { n: number };
}

/**
 * The single place where a program's tool call is judged: existence, write authorization, input schema, timeout,
 * output cap, call limit and audit. Every ToolComposer adapter dispatches through it, so the rules cannot drift.
 */
export class ToolHost {
  constructor(
    private readonly tools: ReadonlyMap<string, ToolDef>,
    private readonly ctx: ToolContext,
    private readonly onAudit: (c: CallAudit) => void,
  ) {}

  /** `violation` means the run must be killed (limits); otherwise reply to the program. */
  async call(name: string, args: unknown, run: RunState): Promise<{ violation: string } | { reply: HostReply }> {
    // count at receipt: a burst of concurrent calls must not slip past a limit that only counts completed calls
    if (++run.received.n > run.limits.maxCalls) return { violation: `call limit of ${run.limits.maxCalls} exceeded` };
    const t0 = Date.now();
    const audit = (a: Omit<CallAudit, 'tool' | 'ms'>): void => {
      const rec = { tool: name, ms: Date.now() - t0, ...a };
      run.calls.push(rec);
      this.onAudit(rec);
    };
    const deny = (why: string, error: string): { reply: HostReply } => (audit({ ok: false, bytes: 0, truncated: false, denied: why }), { reply: { ok: false, error } });
    const tool = this.tools.get(name);
    if (!tool) return deny('unknown tool', `unknown tool ${name}`);
    if (tool.mode === 'write' && !run.writes.has(name)) return deny('write not permitted', `${name} is a mutating tool and was not authorized for this run`);
    const parsed = tool.input.safeParse(args);
    if (!parsed.success) return deny('invalid input', `invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    let timer: NodeJS.Timeout | undefined;
    try {
      const out = await Promise.race([tool.handler(parsed.data, this.ctx), new Promise<never>((_r, rej) => (timer = setTimeout(() => rej(new Error(`${name} timed out`)), tool.timeoutMs)))]);
      const cut = truncateValue(out, tool.maxOutputBytes);
      const bytes = byteLen(cut.value);
      run.addBytesIn(bytes);
      audit({ ok: true, bytes, truncated: cut.truncated });
      return { reply: { ok: true, value: cut.value } };
    } catch (e) {
      return deny('handler error', redact(e instanceof Error ? e.message : String(e)));
    } finally {
      clearTimeout(timer);
    }
  }
}
