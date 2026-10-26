import { commandSegments, evaluateCommand } from '../policy/command';
import { checkPath } from '../policy/paths';

export interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export interface HookDecision {
  decision: 'allow' | 'deny' | 'ask';
  reason: string;
  /** an allow that skips Claude Code's own permission prompt; only for ProofLoop commands that cannot change state */
  explicit?: boolean;
}

const MUTATING = new Set(['approve', 'reject', 'cancel', 'pause', 'resume', 'run', 'gates', 'artifact', 'perf', 'blueprint', 'waive']);
/** ProofLoop commands that only plan, read or run the project's own checks. Never prompt for these. */
const SAFE = new Set(['feature', 'bug', 'diagnose', 'performance', 'refactor', 'security', 'start-project', 'status', 'wait', 'report', 'readiness', 'ledger', 'memory', 'protocols', 'verify', 'test', 'audit', 'selftest', 'setup']);
const HUMAN_ONLY = new Set(['approve', 'reject']);
const WRAPPERS = new Set(['env', 'sudo', 'node', 'npx', 'bash', 'sh', 'zsh', 'command', 'exec', 'time', 'nohup']);
const ASSIGNMENT = /^\w+=/;

/** The ProofLoop subcommand a shell segment actually invokes, or null. Words inside a grep pattern or a path do not count. */
function proofloopSubcommand(segment: string): string | null {
  const tokens = segment.split(/\s+/).map((t) => t.replace(/^["'(]+|["')]+$/g, '')).filter(Boolean);
  const at = tokens.findIndex((t) => /(^|[\\/])(proofloop|main\.js|cli\.js)$/.test(t));
  if (at < 0) return null;
  const before = tokens.slice(0, at);
  if (!before.every((t) => WRAPPERS.has(t) || ASSIGNMENT.test(t) || t.startsWith('-'))) return null;
  return tokens.slice(at + 1).find((t) => !t.startsWith('-')) ?? null;
}

const subcommands = (command: string): string[] => [command, ...commandSegments(command)].map(proofloopSubcommand).filter((x): x is string => x !== null);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * PreToolUse guard. Deterministic: agent sessions can never run ProofLoop state-changing commands or critical
 * shell commands, and nobody can write through the path denylist. Interactive approvals always surface a prompt.
 */
export function evaluateHook(input: HookInput, env: NodeJS.ProcessEnv): HookDecision {
  const agent = env.PROOFLOOP_AGENT_SESSION === '1';
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  const cwd = input.cwd ?? process.cwd();
  if (tool === 'Bash') return bashDecision(String(ti.command ?? ''), agent);
  const path = typeof ti.file_path === 'string' ? ti.file_path : typeof ti.notebook_path === 'string' ? ti.notebook_path : null;
  if (path && (FILE_TOOLS.has(tool) || tool === 'Read')) {
    const check = checkPath(cwd, path, tool === 'Read' ? 'read' : 'write');
    if (!check.ok) return { decision: 'deny', reason: `ProofLoop policy: ${check.reason}` };
  }
  return { decision: 'allow', reason: 'no policy objection' };
}

const STATE_ACCESS = /state\.db|ledger\.key|\.proofloop[\\/]+(state|artifacts)|cli[\\/]main\.js|dist[\\/]cli\.js/;

function bashDecision(command: string, agent: boolean): HookDecision {
  if (STATE_ACCESS.test(command))
    return agent ? { decision: 'deny', reason: 'ProofLoop state, ledger key and CLI internals are not accessible to agent sessions' } : { decision: 'ask', reason: 'This command touches ProofLoop state or the ledger key; confirm it is intended' };
  const subs = subcommands(command);
  if (subs.some((x) => MUTATING.has(x))) {
    if (agent) return { decision: 'deny', reason: 'ProofLoop state, approvals and gates can only be changed by the engine or a human, never by an agent session' };
    if (subs.some((x) => HUMAN_ONLY.has(x))) return { decision: 'ask', reason: 'Approving or rejecting a ProofLoop plan is a human decision. Confirm you reviewed the plan.' };
  }
  // compound commands are malformed for the allowlist, but each segment is still judged so `ls; terraform apply` is caught
  for (const seg of [command, ...commandSegments(command)]) {
    const verdict = evaluateCommand(seg, { allowed: [['*']] });
    if (verdict.verdict === 'needs_approval' && (verdict.cls === 'critical' || verdict.cls === 'destructive'))
      return agent ? { decision: 'deny', reason: `ProofLoop policy: ${verdict.reason} requires explicit human approval immediately before the action` } : { decision: 'ask', reason: `ProofLoop policy: ${verdict.reason}; confirm this ${verdict.cls} action` };
  }
  if (isPlainSafeCall(command, subs)) return { decision: 'allow', reason: 'read-only or planning ProofLoop command', explicit: true };
  return { decision: 'allow', reason: 'no policy objection' };
}

/** One ProofLoop invocation and nothing else on the line (no chaining, redirects or substitution outside quotes). */
function isPlainSafeCall(command: string, subs: string[]): boolean {
  const bare = command.replaceAll('${CLAUDE_PLUGIN_ROOT}', '').replace(/'[^']*'/g, '').replace(/"[^"$`\\]*"/g, '');
  return new Set(subs).size === 1 && SAFE.has(subs[0]!) && !/[;&|<>`$()\n\\]/.test(bare) && !/\bsetup\b.*--yes/.test(bare);
}

export function hookOutput(d: HookDecision): string {
  if (d.decision === 'allow' && !d.explicit) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } });
}

const FILLER = new Set(['please', 'proofloop', 'run', 'the', 'and', 'only', 'suite', 'suites', 'test', 'tests', 'testing', 'every', 'everything', 'all']);
const SUITE_NAMES = ['unit', 'lint', 'typecheck', 'build', 'integration', 'browser', 'security', 'migration', 'regression'];

/** A prompt that is only "test", "run all tests", "test unit and browser"... returns the checks named ([] = everything); anything else is not a test request. */
export function testRequest(prompt: string): string[] | null {
  const words = prompt.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.some((w) => w.startsWith('test'))) return null;
  const suites = words.filter((w) => SUITE_NAMES.includes(w));
  return words.every((w) => FILLER.has(w) || SUITE_NAMES.includes(w)) ? suites : null;
}

const MAX_AUDIT_WORDS = 25;
const ms = (m: RegExpMatchArray | null): number | undefined => (m ? Math.round(Number(m[1]) * (m[2]?.toLowerCase() === 's' ? 1000 : 1)) : undefined);

/** A short prompt containing the word "audit" asks for the scale/system-design audit; numbers it states (users, p95, p99) are passed on. */
export function auditRequest(prompt: string): { users?: number; p95?: number; p99?: number } | null {
  const words = prompt.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > MAX_AUDIT_WORDS || !words.some((w) => /^audit/.test(w.replace(/[^a-z]/g, '')))) return null;
  const users = /(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:concurrent\s+)?users?/i.exec(prompt);
  const n = users ? Math.round(Number(users[1]!.replace(/,/g, '')) * (users[2] ? 1000 : 1)) : undefined;
  return { ...(n ? { users: n } : {}), ...(ms(/p95\D{0,12}(\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(prompt)) ? { p95: ms(/p95\D{0,12}(\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(prompt))! } : {}), ...(ms(/p99\D{0,12}(\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(prompt)) ? { p99: ms(/p99\D{0,12}(\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(prompt))! } : {}) };
}

/** UserPromptSubmit: not a security control, so it fails open and only adds context. */
export function promptHookOutput(prompt: string): string {
  const audit = auditRequest(prompt);
  if (audit) {
    const flags = [audit.users ? `--users ${audit.users}` : '', audit.p95 ? `--p95 ${audit.p95}` : '', audit.p99 ? `--p99 ${audit.p99}` : ''].filter(Boolean).join(' ');
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `The user asked for a ProofLoop audit (scale, latency percentiles and system design). Follow the /proofloop:audit skill now: run \`proofloop audit ${flags}\`${flags ? '' : ' (default 2000 users, p95 300 ms, p99 800 ms; say so)'}, then do the system-design review against the checklist with file:line evidence. Do not ask first.` } });
  }
  const suites = testRequest(prompt);
  if (!suites) return '';
  const which = suites.length ? `only ${suites.join(', ')}` : 'every check';
  const additionalContext = `The user asked to run the ProofLoop test protocol on THIS project. Follow the /proofloop:test skill now, covering ${which}: full checks on the current commit, browser journeys with personas, and a regression comparison with the base branch. Do not ask which suites; run it.`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } });
}

const APPROVE_PHRASES = new Set(['approve', 'approved', 'approve it', 'approve plan', 'approve the plan', 'approve and run', 'approve run', 'lgtm', 'go ahead', 'proceed', 'run it', 'ship it']);
const RUN_ID = /\brun_[a-z0-9]+\b/i;

/** The human's one-word approval of the pending plan ("approve", "lgtm", "/proofloop:approve [run-id]"). Anything longer is a normal prompt. */
export function approvalRequest(prompt: string): { runId?: string } | null {
  const slash = /^\/proofloop:approve\b\s*(\S*)\s*$/i.exec(prompt.trim());
  if (slash) return slash[1] ? { runId: slash[1] } : {};
  const text = prompt.toLowerCase().replace(/[^a-z0-9_\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const runId = RUN_ID.exec(text)?.[0];
  const phrase = text.replace(RUN_ID, '').replace(/\s+/g, ' ').trim();
  return APPROVE_PHRASES.has(phrase) ? (runId ? { runId } : {}) : null;
}

export const approvedContext = (runId: string, hash: string, log: string): string =>
  `The user approved the plan (${hash.slice(0, 12)}) for ${runId} with their message. Approval is recorded and the run has started in the background (log: ${log}). Do not run approve or run yourself and do not ask anything. Run \`proofloop wait ${runId}\` (blocks up to 9 minutes, never prompts); if it says the run is still going, run it again. When it ends, run \`proofloop report ${runId}\` and tell the user: final state, each gate PASS/FAIL/BLOCKED, the PR link if any, and what is not proven.`;
