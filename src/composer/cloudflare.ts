import { type ComposeOptions, type ComposeResult, type ToolComposer } from './types';

/**
 * Optional Cloudflare Code Mode adapter. Cloudflare documents Code Mode as experimental, and no ProofLoop release has
 * been verified against the live service, so this adapter is disabled and fails closed. Enabling it is an explicit,
 * documented data-flow decision: the program text and the tool *schemas* would leave the machine; repository contents
 * would not unless a tool result is forwarded, which this adapter does not do.
 */
export class CloudflareToolComposer implements ToolComposer {
  readonly name = 'cloudflare-codemode';
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  available(): { ok: boolean; reason?: string } {
    if (this.env.PROOFLOOP_CODEMODE_CLOUDFLARE !== '1') return { ok: false, reason: 'disabled (set PROOFLOOP_CODEMODE_CLOUDFLARE=1 to opt in; experimental upstream)' };
    return { ok: false, reason: 'not implemented: no ProofLoop release has been verified against the live Cloudflare API' };
  }

  describeTools(): ReturnType<ToolComposer['describeTools']> {
    return [];
  }

  async run(program: string, opts?: ComposeOptions): Promise<ComposeResult> {
    void program;
    void opts;
    const a = this.available();
    return { ok: false, error: `cloudflare adapter unavailable: ${a.reason}`, calls: [], durationMs: 0, bytesIn: 0, bytesOut: 0 };
  }
}

export function createComposer(kind: 'local' | 'cloudflare', make: () => ToolComposer, env: NodeJS.ProcessEnv = process.env): ToolComposer {
  return kind === 'cloudflare' ? new CloudflareToolComposer(env) : make();
}
