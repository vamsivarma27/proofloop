import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AC_TRACEABILITY_GATE, MIGRATION_GATE, REQUIRED_ARTIFACTS_GATE, buildGatePlan, TEST_INTEGRITY_GATE, type GatePlanEntry } from '../gates/plan';
import { riskRank } from '../protocol/schema';
import { branchName } from '../git/git';
import { submitPlan } from '../plan/workflow';
import { blueprintDocs } from '../blueprint/render';
import { getBlueprint } from '../blueprint/workflow';
import { RepoContext } from '../repo/context';
import { isPlError } from '../shared/errors';
import { REPRODUCTION_GATE } from './bug';
import { type EngineDeps, callAgent, isRateLimited, loggerOf, worktreeRoot } from './deps';
import { planJsonSchema, plannerPrompt } from './prompts';

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'into', 'page', 'user', 'users', 'make', 'add', 'fix']);
export const keywordsOf = (text: string): string[] => [...new Set(text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])].filter((w) => !STOP.has(w)).slice(0, 8);

export async function block(d: EngineDeps, runId: string, reason: string): Promise<void> {
  const run = d.store.getRun(runId);
  d.store.transition(runId, 'BLOCKED', { actor: 'engine', reason: reason.slice(0, 500) });
  loggerOf(d).log('warn', 'run.blocked', { run: runId, from: run.state, reason });
  await d.github.checkpoint(runId, `blocked-${d.store.events(runId, 'transition').length}`, `**Blocked** (${run.state}): ${reason}\n\nEvidence is preserved locally; resume with \`proofloop resume ${runId} --retry\` once resolved.`);
}

export function stepRecon(d: EngineDeps, runId: string): void {
  const s = d.store.beginStep(runId, 'recon');
  d.store.transition(runId, 'PLANNING', { actor: 'engine' });
  d.store.finishStep(s.id, { state: 'DONE' });
}

const asJson = (text: string): unknown => {
  try {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return undefined;
  }
};

/** Ask the planner for a plan, feed validation errors back (bounded), then park at AWAITING_APPROVAL. */
export async function stepPlan(d: EngineDeps, runId: string): Promise<void> {
  const run = d.store.getRun(runId);
  const protocol = d.registry.get(run.protocolId);
  const files = await new RepoContext(d.root, d.exec).relevantFiles(keywordsOf(run.intent));
  const step = d.store.beginStep(runId, 'plan');
  let errors: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await callAgent(d, run, { role: 'planner', cwd: d.root, prompt: plannerPrompt({ protocol, intent: run.intent, detected: d.detected, files, priorErrors: errors }), jsonSchema: planJsonSchema() });
    if (!res.ok) {
      d.store.finishStep(step.id, { state: 'FAILED', errorCategory: isRateLimited(res) ? 'rate-limit' : 'agent' });
      return block(d, runId, `planner failed: ${res.error}`);
    }
    try {
      const sub = submitPlan(d.store, runId, res.structured ?? asJson(res.text));
      d.store.finishStep(step.id, { state: 'DONE', outputRef: sub.hash });
      await d.github.checkpoint(runId, `plan-v${sub.version}`, `${sub.markdown}\n${gatePreview(d, runId)}\n\n_Awaiting human approval. Approve with \`proofloop approve ${runId} --plan-hash ${sub.hash}\`._`);
      return;
    } catch (e) {
      if (!isPlError(e, 'PL_PLAN_010')) throw e;
      errors = (e.details as string[]) ?? [e.message];
    }
  }
  d.store.finishStep(step.id, { state: 'FAILED', errorCategory: 'invalid-plan' });
  return block(d, runId, `planner could not produce a valid plan after 3 attempts: ${errors.join('; ')}`);
}

export function currentGateEntries(d: EngineDeps, runId: string): GatePlanEntry[] {
  const run = d.store.getRun(runId);
  const body = d.store.getPlanBody(runId) as { gateCommands?: Record<string, string>; regressionTest?: { command: string } } | undefined;
  // the approved plan's regression test command is the regression-test gate unless the plan binds it explicitly
  const commands = { ...(body?.regressionTest ? { 'regression-test': body.regressionTest.command } : {}), ...(body?.gateCommands ?? {}) };
  const base = buildGatePlan(d.registry.get(run.protocolId), run.risk, d.detected, d.config, commands);
  const traced = riskRank(run.risk) >= riskRank('medium') && Boolean((d.store.getPlanBody(runId) as { acceptanceCriteria?: unknown } | undefined)?.acceptanceCriteria);
  const protocol = d.registry.get(run.protocolId);
  const engineGates = [TEST_INTEGRITY_GATE, ...(traced ? [AC_TRACEABILITY_GATE] : []), ...(protocol.requiredArtifacts.length ? [REQUIRED_ARTIFACTS_GATE] : []), ...(protocol.mode === 'existing-repo' ? [MIGRATION_GATE] : [])];
  return [...base, ...engineGates, ...(run.protocolId === 'bug' ? [REPRODUCTION_GATE] : [])];
}

export function gatePreview(d: EngineDeps, runId: string): string {
  const rows = currentGateEntries(d, runId).map((e) => `- ${e.gateId}: ${e.command ? `\`${e.command}\` (${e.source})` : '**no command detected**'}${e.unsupported ? ' — not required: repository does not support this check' : e.required ? ' — required' : ''}`);
  return `\n## Gate plan preview\n${rows.join('\n')}\n`;
}

export function syncGatePlan(d: EngineDeps, runId: string): GatePlanEntry[] {
  const entries = currentGateEntries(d, runId);
  d.store.setGatePlan(runId, entries.map((e) => ({ gateId: e.gateId, kind: e.kind, required: e.required, command: e.command })));
  return entries;
}

export function excludeStateDir(root: string, extraDirs: readonly string[] = []): void {
  const file = join(root, '.git', 'info', 'exclude');
  if (!existsSync(join(root, '.git'))) return;
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  // local-only ignores: harness state and test-run outputs must never be swept into commits by `git add -A`
  const wanted = ['.proofloop/', 'test-results/', 'playwright-report/', 'blob-report/', ...extraDirs.map((x) => `${x.replace(/\/$/, '')}/`)];
  const missing = wanted.filter((w) => !text.split('\n').includes(w));
  if (missing.length) appendFileSync(file, `${text.endsWith('\n') || text === '' ? '' : '\n'}${missing.join('\n')}\n`);
}

/** Isolated branch + worktree and the gate plan; idempotent so resume can call it again. */
export async function stepReady(d: EngineDeps, runId: string): Promise<void> {
  const run = d.store.getRun(runId);
  if (!run.worktreePath || !existsSync(run.worktreePath)) {
    excludeStateDir(d.root, d.config.app.artifactDirs);
    const branch = run.activeBranch ?? branchName(run.protocolId, run.intent, run.id);
    const base = run.baseCommit ?? (await d.git.head(d.root));
    const wt = await d.git.createWorktree(d.root, branch, base, join(worktreeRoot(d, runId), 'integration'));
    d.store.setFields(runId, { baseCommit: base, activeBranch: branch, worktreePath: wt.path, headSha: wt.head });
  }
  if (d.registry.get(run.protocolId).mode === 'idea-to-product') await writeBlueprintDocs(d, runId);
  syncGatePlan(d, runId);
  d.store.transition(runId, 'RUNNING', { actor: 'engine' });
}

/** Idea-to-Product delivers the approved blueprint, roadmap and ADRs as reviewable files in the worktree. */
async function writeBlueprintDocs(d: EngineDeps, runId: string): Promise<void> {
  const run = d.store.getRun(runId);
  const needs = JSON.parse(d.store.getKey(`needs-confirmation:${runId}`) ?? '[]') as string[];
  for (const f of blueprintDocs(getBlueprint(d.store, runId), run.currentPlanHash!, needs)) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(run.worktreePath!, f.path, '..'), { recursive: true });
    writeFileSync(join(run.worktreePath!, f.path), f.content);
  }
  const sha = await d.git.commitAll(run.worktreePath!, 'docs: add product blueprint, roadmap and decision records');
  if (sha) d.store.setFields(runId, { headSha: sha });
}
