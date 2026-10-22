import { type Exec, nodeExec } from '../shared/exec';
import { DEFAULT_ENV_ALLOW, redact, scrubbedEnv } from '../shared/redact';

export const AGENT_ROLES = ['planner', 'implementer', 'test-designer', 'reviewer', 'security-reviewer', 'browser-evaluator', 'researcher', 'product-discovery', 'evidence-evaluator'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AgentRequest {
  role: AgentRole;
  runId: string;
  prompt: string;
  cwd: string;
  /** Resume this session (implementer repair loops). Evaluators never resume: they get fresh context. */
  resumeSessionId?: string;
  jsonSchema?: object;
  allowedTools?: readonly string[];
  maxBudgetUsd: number;
  timeoutMs: number;
  appendSystemPrompt?: string;
}

export interface AgentResult {
  ok: boolean;
  sessionId: string | null;
  text: string;
  structured?: unknown;
  costUsd?: number;
  error?: string;
  permissionDenials: unknown[];
}

export interface AgentRuntime {
  readonly name: string;
  run(req: AgentRequest): Promise<AgentResult>;
}

const READ_ONLY = ['Read', 'Grep', 'Glob', 'Bash(git log *)', 'Bash(git diff *)', 'Bash(git show *)', 'Bash(git status *)'] as const;
const EDITING = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash(git diff *)', 'Bash(git status *)', 'Bash(git log *)'] as const;

/** Tool surface per role: evaluators are read-only (separation of duties); only the implementer can edit. */
export const ROLE_TOOLS: Record<AgentRole, readonly string[]> = {
  planner: READ_ONLY,
  implementer: EDITING,
  'test-designer': EDITING,
  reviewer: READ_ONLY,
  'security-reviewer': READ_ONLY,
  'browser-evaluator': READ_ONLY,
  researcher: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
  'product-discovery': ['Read', 'Grep', 'Glob'],
  'evidence-evaluator': READ_ONLY,
};

/** Always denied to agents regardless of role: they must not touch approvals, state or gates. */
export const ALWAYS_DENIED = ['Bash(proofloop approve *)', 'Bash(proofloop reject *)', 'Bash(proofloop gates *)', 'Bash(proofloop cancel *)', 'Bash(proofloop run *)', 'Bash(git push *)', 'Bash(git commit *--no-verify*)', 'Bash(sudo *)', 'Bash(rm -rf *)'] as const;

export const MIN_CLAUDE_VERSION = [2, 1, 259] as const;

export function parseVersion(text: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) if ((v[i] ?? 0) !== (min[i] ?? 0)) return (v[i] ?? 0) > (min[i] ?? 0);
  return true;
}

export interface ClaudeRuntimeOptions {
  exec?: Exec;
  bin?: string;
  model?: string;
  /** Absolute path to the proofloop executable used by the PreToolUse guard hook. */
  guardCommand?: string;
  permissionMode?: 'dontAsk' | 'acceptEdits';
}

const AGENT_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'USER', 'LOGNAME'];

/**
 * Drives Claude Code through its documented non-interactive interface only:
 * `claude -p` with --output-format json, --json-schema, --resume, --allowedTools, --permission-mode, --settings.
 */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly name = 'claude-code';
  private readonly exec: Exec;
  constructor(private readonly opts: ClaudeRuntimeOptions = {}) {
    this.exec = opts.exec ?? nodeExec;
  }

  async checkVersion(): Promise<{ ok: boolean; version: string | null; problem?: string }> {
    const r = await this.exec(this.opts.bin ?? 'claude', ['--version'], { timeoutMs: 15_000 });
    if (r.spawnError) return { ok: false, version: null, problem: 'claude CLI not found on PATH' };
    const v = parseVersion(r.stdout);
    if (!v) return { ok: false, version: null, problem: `unparseable version: ${r.stdout.slice(0, 80)}` };
    const text = v.join('.');
    return versionAtLeast(v, MIN_CLAUDE_VERSION) ? { ok: true, version: text } : { ok: false, version: text, problem: `need Claude Code >= ${MIN_CLAUDE_VERSION.join('.')}` };
  }

  buildArgs(req: AgentRequest): string[] {
    const allowed = [...(req.allowedTools ?? ROLE_TOOLS[req.role])];
    const args = ['-p', '--output-format', 'json', '--permission-mode', this.opts.permissionMode ?? 'dontAsk', '--permission-prompts', 'none', '--max-budget-usd', String(req.maxBudgetUsd)];
    args.push('--allowedTools', allowed.join(','), '--disallowedTools', ALWAYS_DENIED.join(','));
    if (this.opts.model) args.push('--model', this.opts.model);
    if (req.resumeSessionId && req.role === 'implementer') args.push('--resume', req.resumeSessionId);
    if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema));
    if (req.appendSystemPrompt) args.push('--append-system-prompt', req.appendSystemPrompt);
    if (this.opts.guardCommand) {
      const hook = { hooks: { PreToolUse: [{ matcher: 'Bash|Edit|Write', hooks: [{ type: 'command', command: `${JSON.stringify(this.opts.guardCommand)} hook pre-tool-use` }] }] } };
      args.push('--settings', JSON.stringify(hook));
    }
    return args;
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    const env = { ...scrubbedEnv(process.env, [...DEFAULT_ENV_ALLOW, ...AGENT_ENV]), PROOFLOOP_AGENT_SESSION: '1', PROOFLOOP_ROLE: req.role, PROOFLOOP_RUN_ID: req.runId };
    const r = await this.exec(this.opts.bin ?? 'claude', this.buildArgs(req), { cwd: req.cwd, input: req.prompt, timeoutMs: req.timeoutMs, env, maxBytes: 16 * 1024 * 1024 });
    if (r.spawnError) return fail(`claude CLI could not start (${r.spawnError})`);
    if (r.timedOut) return fail(`agent timed out after ${req.timeoutMs}ms`);
    return parseResult(r.stdout, r.code, r.stderr);
  }
}

const fail = (error: string): AgentResult => ({ ok: false, sessionId: null, text: '', error: redact(error), permissionDenials: [] });

export function parseResult(stdout: string, code: number | null, stderr = ''): AgentResult {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return fail(`agent output was not JSON (exit ${code}): ${(stderr || stdout).slice(0, 300)}`);
  }
  const isError = j.is_error === true || (typeof j.subtype === 'string' && j.subtype.startsWith('error')) || code !== 0;
  return {
    ok: !isError,
    sessionId: typeof j.session_id === 'string' ? j.session_id : null,
    text: redact(typeof j.result === 'string' ? j.result : ''),
    structured: j.structured_output,
    costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined,
    error: isError ? redact(typeof j.result === 'string' && j.result ? j.result : `agent exited ${code}`) : undefined,
    permissionDenials: Array.isArray(j.permission_denials) ? j.permission_denials : [],
  };
}

/** Scripted runtime for tests and offline evals; handlers can edit files in cwd like an implementer would. */
export class ScriptedRuntime implements AgentRuntime {
  readonly name = 'scripted';
  readonly calls: AgentRequest[] = [];
  constructor(private readonly handler: (req: AgentRequest, n: number) => Partial<AgentResult> | Promise<Partial<AgentResult>>) {}
  async run(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    const out = await this.handler(req, this.calls.length);
    return { ok: true, sessionId: `sess-${this.calls.length}`, text: '', permissionDenials: [], ...out };
  }
}
