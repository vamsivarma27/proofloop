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

const MUTATING = /\b(proofloop|main\.js|cli\.js)\b[^\n]*\b(approve|reject|cancel|pause|resume|run|gates|artifact|perf|blueprint|waive)\b/;
const HUMAN_ONLY = /\b(proofloop|main\.js|cli\.js)\b[^\n]*\b(approve|reject)\b/;
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
  if (MUTATING.test(command)) {
    if (agent) return { decision: 'deny', reason: 'ProofLoop state, approvals and gates can only be changed by the engine or a human, never by an agent session' };
    if (HUMAN_ONLY.test(command)) return { decision: 'ask', reason: 'Approving or rejecting a ProofLoop plan is a human decision. Confirm you reviewed the plan.' };
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
