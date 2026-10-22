import { hashObject } from '../shared/hash';
import { PlError } from '../shared/errors';
import type { BuiltinOutcome, GateRunCtx } from '../gates/runner';
import type { Store, TaskRun } from '../state/store';
import { isInterviewComplete, loadInterview, unanswered } from './interview';
import { renderBlueprintMarkdown } from './render';
import { type Blueprint, assumptionsVisible, validateBlueprint } from './schema';

export interface BlueprintSubmit {
  run: TaskRun;
  hash: string;
  markdown: string;
  warnings: string[];
  needsConfirmation: string[];
}

/** Records a validated blueprint as the run's plan and parks it at AWAITING_APPROVAL. Invalid input changes nothing. */
export function submitBlueprint(store: Store, runId: string, input: unknown, actor = 'agent:product-discovery'): BlueprintSubmit {
  const run0 = store.getRun(runId);
  if (run0.protocolId !== 'idea-to-product') throw new PlError('PL_BLUEPRINT_002', `run ${runId} is a ${run0.protocolId} run, not idea-to-product`);
  const interview = loadInterview(store, runId);
  if (!isInterviewComplete(interview)) throw new PlError('PL_BLUEPRINT_003', `interview incomplete; still unanswered: ${unanswered(interview).join(', ')}. Ask the user, or have them say "decide for me" to record visible defaults.`);
  const v = validateBlueprint(input);
  if (!v.blueprint) {
    store.audit(runId, 'blueprint.invalid', actor, { errors: v.errors });
    throw new PlError('PL_BLUEPRINT_010', `blueprint rejected:\n- ${v.errors.join('\n- ')}`, v.errors);
  }
  const hash = hashObject(v.blueprint);
  if (run0.state === 'DISCOVERING') store.transition(runId, 'PLANNING', { actor });
  let run = store.recordPlan(runId, v.blueprint, hash);
  store.setKey(`needs-confirmation:${runId}`, JSON.stringify(v.needsConfirmation));
  if (run.state === 'PLANNING') run = store.transition(runId, 'AWAITING_APPROVAL', { actor });
  return { run, hash, markdown: renderBlueprintMarkdown(v.blueprint, hash, v.needsConfirmation), warnings: v.warnings, needsConfirmation: v.needsConfirmation };
}

export const getBlueprint = (store: Store, runId: string): Blueprint => {
  const body = store.getPlanBody(runId);
  if (!body) throw new PlError('PL_BLUEPRINT_404', 'no blueprint recorded for this run');
  return body as Blueprint;
};

export async function blueprintValid(ctx: GateRunCtx): Promise<BuiltinOutcome> {
  const v = validateBlueprint(ctx.store.getPlanBody(ctx.runId));
  return v.blueprint ? { state: 'PASS', summary: `blueprint valid (${v.warnings.length} warning(s))` } : { state: 'FAIL', category: 'blueprint-invalid', summary: v.errors.join('; ') };
}

export async function assumptionsVisibleGate(ctx: GateRunCtx): Promise<BuiltinOutcome> {
  const bp = validateBlueprint(ctx.store.getPlanBody(ctx.runId)).blueprint;
  if (!bp) return { state: 'FAIL', category: 'blueprint-invalid', summary: 'blueprint is invalid' };
  const hidden = assumptionsVisible(bp);
  return hidden.length ? { state: 'FAIL', category: 'assumption-hidden', summary: `high-impact assumptions not surfaced for confirmation: ${hidden.join(', ')}` } : { state: 'PASS', summary: 'all high-impact assumptions are visible to the approver' };
}

export const blueprintBuiltins = { 'blueprint-valid': blueprintValid, 'assumptions-visible': assumptionsVisibleGate };
