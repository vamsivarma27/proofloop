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
}

const MUTATING = new Set(['approve', 'reject', 'cancel', 'pause', 'resume', 'run', 'gates', 'artifact', 'perf', 'blueprint', 'waive']);
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
  return { decision: 'allow', reason: 'no policy objection' };
}

export function hookOutput(d: HookDecision): string {
  if (d.decision === 'allow') return '';
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

/** UserPromptSubmit: not a security control, so it fails open and only adds context. */
export function promptHookOutput(prompt: string): string {
  const suites = testRequest(prompt);
  if (!suites) return '';
  const which = suites.length ? `only ${suites.join(', ')}` : 'every check';
  const additionalContext = `The user asked to run the ProofLoop test protocol on THIS project. Follow the /proofloop:test skill now, covering ${which}: full checks on the current commit, browser journeys with personas, and a regression comparison with the base branch. Do not ask which suites; run it.`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } });
}
