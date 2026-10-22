export const STATES = [
  'NEW',
  'DISCOVERING',
  'PLANNING',
  'AWAITING_APPROVAL',
  'APPROVED',
  'READY',
  'RUNNING',
  'VERIFYING',
  'REPAIRING',
  'REVIEW_REQUIRED',
  'PR_OPEN',
  'COMPLETE',
  'BLOCKED',
  'PAUSED',
  'CANCELLED',
] as const;
export type TaskState = (typeof STATES)[number];

export const TERMINAL_STATES: readonly TaskState[] = ['COMPLETE', 'CANCELLED'];

const TABLE: Record<TaskState, readonly TaskState[]> = {
  NEW: ['DISCOVERING', 'CANCELLED'],
  DISCOVERING: ['PLANNING', 'BLOCKED', 'CANCELLED'],
  PLANNING: ['AWAITING_APPROVAL', 'BLOCKED', 'CANCELLED'],
  AWAITING_APPROVAL: ['APPROVED', 'PLANNING', 'CANCELLED'],
  APPROVED: ['READY', 'BLOCKED', 'CANCELLED'],
  READY: ['RUNNING', 'BLOCKED', 'CANCELLED'],
  RUNNING: ['VERIFYING', 'BLOCKED', 'PAUSED', 'CANCELLED'],
  VERIFYING: ['REVIEW_REQUIRED', 'REPAIRING', 'BLOCKED', 'CANCELLED'],
  REPAIRING: ['RUNNING', 'BLOCKED', 'CANCELLED'],
  REVIEW_REQUIRED: ['PR_OPEN', 'REPAIRING', 'BLOCKED', 'CANCELLED'],
  PR_OPEN: ['COMPLETE', 'REPAIRING', 'BLOCKED', 'CANCELLED'],
  PAUSED: ['READY', 'CANCELLED'],
  BLOCKED: ['DISCOVERING', 'PLANNING', 'READY', 'CANCELLED'],
  COMPLETE: [],
  CANCELLED: [],
};

export const allowedTransitions = (from: TaskState): readonly TaskState[] => TABLE[from];
export const isAllowedTransition = (from: TaskState, to: TaskState): boolean => TABLE[from].includes(to);

/** Gates the engine adds itself; they can never be the only thing standing between a change and delivery. */
export const ENGINE_GATE_IDS: readonly string[] = ['test-integrity', 'reproduction-proven', 'ac-traceability', 'required-artifacts', 'migration-readiness'];

export type GateState = 'PASS' | 'FAIL' | 'BLOCKED';

export interface GateSnapshot {
  gateId: string;
  state: GateState | 'MISSING';
  commitSha: string | null;
}

/** Everything a guard may look at; computed inside the transition transaction. */
export interface GuardContext {
  currentPlanHash: string | null;
  approvedPlanHash: string | null;
  headSha: string | null;
  requiredGates: readonly GateSnapshot[];
  repairCount: number;
  repairBudget: number;
  prUrl: string | null;
}

export type GuardResult = { ok: true } | { ok: false; code: string; reason: string };
const ok: GuardResult = { ok: true };
const deny = (code: string, reason: string): GuardResult => ({ ok: false, code, reason });

function approvalValid(ctx: GuardContext): GuardResult {
  if (!ctx.currentPlanHash) return deny('PL_STATE_010', 'no plan has been recorded');
  if (ctx.approvedPlanHash !== ctx.currentPlanHash)
    return deny('PL_STATE_011', 'the current plan version has not been approved (edited plans need fresh approval)');
  return ok;
}

/** Required gates must all be PASS on the exact head commit; missing/blocked/stale gates are not passes. */
export function gatesGreen(ctx: GuardContext): GuardResult {
  if (!ctx.headSha) return deny('PL_STATE_020', 'no head commit recorded to verify');
  if (ctx.requiredGates.every((g) => ENGINE_GATE_IDS.includes(g.gateId))) return deny('PL_STATE_021', 'no repository check is required and runnable; a missing test is not a pass');
  const bad = ctx.requiredGates.filter((g) => g.state !== 'PASS' || g.commitSha !== ctx.headSha);
  if (bad.length === 0) return ok;
  const why = bad.map((g) => `${g.gateId}=${g.state}${g.state === 'PASS' ? '(stale commit)' : ''}`).join(', ');
  return deny('PL_STATE_022', `required gates not passing on ${ctx.headSha.slice(0, 8)}: ${why}`);
}

export function checkGuards(from: TaskState, to: TaskState, ctx: GuardContext): GuardResult {
  switch (to) {
    case 'AWAITING_APPROVAL':
      return ctx.currentPlanHash ? ok : deny('PL_STATE_010', 'cannot await approval without a plan');
    case 'APPROVED':
    case 'READY':
      return approvalValid(ctx);
    case 'RUNNING':
      return approvalValid(ctx);
    case 'VERIFYING':
      return ctx.headSha ? ok : deny('PL_STATE_020', 'no head commit recorded to verify');
    case 'REPAIRING':
      return ctx.repairCount < ctx.repairBudget
        ? ok
        : deny('PL_STATE_030', `repair budget exhausted (${ctx.repairCount}/${ctx.repairBudget}); block with evidence instead`);
    case 'REVIEW_REQUIRED':
      return gatesGreen(ctx);
    case 'PR_OPEN':
      return ctx.prUrl ? gatesGreen(ctx) : deny('PL_STATE_040', 'no pull request URL recorded');
    case 'COMPLETE':
      if (from !== 'PR_OPEN') return deny('PL_STATE_041', 'only an open PR can complete');
      return gatesGreen(ctx);
    default:
      return ok;
  }
}
