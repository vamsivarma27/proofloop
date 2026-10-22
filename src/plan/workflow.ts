import { hostname, userInfo } from 'node:os';
import { PlError } from '../shared/errors';
import { hashObject } from '../shared/hash';
import type { Store, TaskRun } from '../state/store';
import { type Plan, type PlanValidation, renderPlanMarkdown, validatePlan } from './schema';

export const humanActor = (): string => `human:${userInfo().username}@${hostname()}`;

export interface SubmitResult {
  run: TaskRun;
  hash: string;
  version: number;
  warnings: string[];
  markdown: string;
}

/** Validates, stores and (from PLANNING) moves a plan to AWAITING_APPROVAL. Invalid plans change nothing. */
export function submitPlan(store: Store, runId: string, input: unknown, actor = 'agent:planner'): SubmitResult {
  const run0 = store.getRun(runId);
  const v: PlanValidation = validatePlan(input, { protocolId: run0.protocolId });
  if (!v.plan) {
    store.audit(runId, 'plan.invalid', actor, { errors: v.errors });
    throw new PlError('PL_PLAN_010', `plan rejected:\n- ${v.errors.join('\n- ')}`, v.errors);
  }
  const plan: Plan = v.plan;
  const hash = hashObject(plan);
  let run = store.recordPlan(runId, plan, hash);
  store.saveTaskNodes(runId, plan.tasks.map((t) => ({ id: t.id, title: t.title, description: t.description, dependencies: t.dependencies, fileScopes: t.fileScopes, acceptanceCriteria: t.acceptanceCriteria, riskLevel: t.risk })));
  store.raiseRisk(runId, v.effectiveRisk!);
  if (run.state === 'PLANNING') run = store.transition(runId, 'AWAITING_APPROVAL', { actor });
  else run = store.getRun(runId);
  return { run, hash, version: run.planVersion, warnings: v.warnings, markdown: renderPlanMarkdown(plan, hash, run.planVersion) };
}

export function approvePlan(store: Store, runId: string, a: { planHash: string; by: string; comment?: string }): TaskRun {
  store.recordApproval(runId, { scope: 'plan', planHash: a.planHash, approvedBy: a.by, decision: 'approve', comment: a.comment });
  return store.transition(runId, 'APPROVED', { actor: a.by });
}

export function rejectPlan(store: Store, runId: string, a: { by: string; comment: string }): TaskRun {
  const run = store.getRun(runId);
  store.recordApproval(runId, { scope: 'plan', planHash: run.currentPlanHash, approvedBy: a.by, decision: 'reject', comment: a.comment });
  return store.transition(runId, 'PLANNING', { actor: a.by, reason: a.comment });
}

/** Explicit approval for one gated action (critical op, test-change, behavior-change). Never inherited from plan approval. */
export function approveGated(store: Store, runId: string, scope: string, by: string, comment?: string): void {
  store.recordApproval(runId, { scope, planHash: null, approvedBy: by, decision: 'approve', comment });
}

export function getPlan(store: Store, runId: string): Plan {
  const body = store.getPlanBody(runId);
  if (!body) throw new PlError('PL_PLAN_404', 'no plan recorded for this run');
  return body as Plan;
}
