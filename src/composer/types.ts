import type { ZodType } from 'zod';

export interface ToolContext {
  root: string;
  runId?: string | undefined;
}

/** A typed, narrow capability. Reads are default-allowed; writes need explicit policy and are audited. */
export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  description: string;
  mode: 'read' | 'write';
  input: ZodType<I>;
  /** Human-readable output shape, shown to the model alongside the input schema. */
  output: string;
  timeoutMs: number;
  maxOutputBytes: number;
  handler(input: I, ctx: ToolContext): Promise<O>;
}

export interface ComposerLimits {
  maxCalls: number;
  maxDurationMs: number;
  /** Cap on the final value returned to the model. */
  maxResultBytes: number;
}

export const DEFAULT_LIMITS: ComposerLimits = { maxCalls: 25, maxDurationMs: 20_000, maxResultBytes: 16 * 1024 };

export interface CallAudit {
  tool: string;
  ok: boolean;
  ms: number;
  bytes: number;
  truncated: boolean;
  denied?: string;
}

export interface ComposeResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  calls: CallAudit[];
  durationMs: number;
  /** Bytes of tool output the program consumed vs bytes returned to the model. */
  bytesIn: number;
  bytesOut: number;
}

export interface ComposeOptions {
  limits?: Partial<ComposerLimits>;
  /** Names of write tools this run may call. Default: none. */
  allowWrites?: readonly string[];
  signal?: AbortSignal;
}

/** Provider-neutral: the engine depends only on this, so the local sandbox and Cloudflare are interchangeable. */
export interface ToolComposer {
  readonly name: string;
  available(): { ok: boolean; reason?: string };
  /** The typed API surface the model may program against (name, mode, schemas). */
  describeTools(): Array<{ name: string; mode: 'read' | 'write'; description: string; input: object; output: string }>;
  run(program: string, opts?: ComposeOptions): Promise<ComposeResult>;
}
