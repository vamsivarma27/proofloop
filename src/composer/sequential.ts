import { z } from 'zod';
import { ToolHost, byteLen, truncateValue } from './host';
import { buildTools, type ToolDeps } from './tools';
import { type CallAudit, type ComposeOptions, type ComposeResult, DEFAULT_LIMITS, type ToolComposer, type ToolContext, type ToolDef } from './types';
import { redact } from '../shared/redact';

const Program = z.array(z.object({ tool: z.string(), args: z.unknown() })).min(1);

/**
 * Fallback with no sandbox and no network: the "program" is a JSON list of `{tool, args}` steps, never code.
 * Nothing the model wrote is executed, so it runs on any Node and needs no isolation; the ToolHost rules still apply.
 * Steps cannot branch or use earlier results; use the local sandbox when a program needs that.
 */
export class SequentialToolComposer implements ToolComposer {
  readonly name = 'sequential-json';
  private readonly tools: Map<string, ToolDef>;
  private readonly host: ToolHost;
  constructor(ctx: ToolContext, deps: ToolDeps & { tools?: ToolDef[]; audit?: (call: CallAudit) => void } = {}) {
    this.tools = new Map((deps.tools ?? buildTools(deps)).map((t) => [t.name, t]));
    this.host = new ToolHost(this.tools, ctx, deps.audit ?? (() => undefined));
  }

  available() {
    return { ok: true };
  }

  describeTools() {
    return [...this.tools.values()].map((t) => ({ name: t.name, mode: t.mode, description: t.description, input: z.toJSONSchema(t.input) as object, output: t.output }));
  }

  async run(program: string, opts: ComposeOptions = {}): Promise<ComposeResult> {
    const started = Date.now();
    const limits = { ...DEFAULT_LIMITS, ...opts.limits };
    const calls: CallAudit[] = [];
    let bytesIn = 0;
    const fail = (error: string): ComposeResult => ({ ok: false, error: redact(error), calls, durationMs: Date.now() - started, bytesIn, bytesOut: 0 });
    let steps: z.infer<typeof Program>;
    try {
      steps = Program.parse(JSON.parse(program));
    } catch (e) {
      return fail(`program rejected: expected a JSON array of {tool, args} steps (${e instanceof Error ? e.message : String(e)})`);
    }
    const run = { limits, writes: new Set(opts.allowWrites ?? []), calls, addBytesIn: (n: number) => void (bytesIn += n), received: { n: 0 } };
    const values: unknown[] = [];
    for (const s of steps) {
      if (opts.signal?.aborted) return fail('cancelled');
      if (Date.now() - started > limits.maxDurationMs) return fail(`time limit of ${limits.maxDurationMs}ms exceeded`);
      const out = await this.host.call(s.tool, s.args, run);
      if ('violation' in out) return fail(out.violation);
      if (!out.reply.ok) return fail(out.reply.error);
      values.push(out.reply.value);
    }
    const cut = truncateValue(values, limits.maxResultBytes);
    return { ok: true, value: cut.value, calls, durationMs: Date.now() - started, bytesIn, bytesOut: byteLen(cut.value) };
  }
}
