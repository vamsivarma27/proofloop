import type { TaskRun } from '../state/store';
import { commitType, type EngineDeps } from './deps';
import { renderReport, verifyEvidenceIntegrity } from './report';
import { block } from './steps-plan';

const LOCAL_PREFIX = 'local-branch:';
export const isLocalDelivery = (url: string | null): boolean => Boolean(url?.startsWith(LOCAL_PREFIX));

function prTitle(d: EngineDeps, run: TaskRun): string {
  const body = (d.store.getPlanBody(run.id) ?? {}) as { intent?: { summary: string }; idea?: { oneLine: string }; affectedModules?: Array<{ path: string }> };
  const summary = body.intent?.summary ?? body.idea?.oneLine ?? run.intent;
  const scope = body.affectedModules?.[0]?.path.split('/').find((s) => s && !s.includes('.') && s !== 'src') ?? run.protocolId;
  return `${commitType(run.protocolId)}(${scope.replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'core'}): ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`.slice(0, 72);
}

export type DeliverOutcome = 'delivered' | { waiting: 'github'; reason: string };

/** Opens the PR only from the ledger: required gates green on the head commit and evidence intact. */
export async function stepDeliver(d: EngineDeps, runId: string): Promise<DeliverOutcome> {
  const run = d.store.getRun(runId);
  const problems = verifyEvidenceIntegrity(d.store, runId);
  if (problems.length) {
    await block(d, runId, `evidence integrity check failed: ${problems.map((p) => p.problem).join('; ')}`);
    return 'delivered';
  }
  const step = d.store.beginStep(runId, 'deliver');
  if (!d.port) {
    d.store.setFields(runId, { prUrl: `${LOCAL_PREFIX}${run.activeBranch}@${run.headSha}` });
    d.store.transition(runId, 'PR_OPEN', { actor: 'engine', reason: 'GitHub disabled: local branch ready, no pull request opened' });
    d.store.finishStep(step.id, { state: 'DONE' });
    return 'delivered';
  }
  try {
    await d.git.run(run.worktreePath!, ['push', '-u', 'origin', run.activeBranch!], { timeoutMs: 120_000 });
    const base = await d.git.defaultBranch(d.root);
    const url = await d.port.openPullRequest({ head: run.activeBranch!, base, title: prTitle(d, run), body: renderReport(d.store, runId, { forPr: true }), cwd: run.worktreePath! });
    d.store.setFields(runId, { prUrl: url });
    d.store.transition(runId, 'PR_OPEN', { actor: 'engine' });
    d.store.finishStep(step.id, { state: 'DONE', outputRef: url });
    await d.github.checkpoint(runId, `delivered-${run.headSha?.slice(0, 8)}`, `Pull request opened: ${url}`);
    return 'delivered';
  } catch (e) {
    d.store.finishStep(step.id, { state: 'FAILED', errorCategory: 'github' });
    return { waiting: 'github', reason: e instanceof Error ? e.message : String(e) };
  }
}

export type PrOutcome = 'complete' | 'repair' | 'blocked' | { waiting: 'merge'; reason: string };

/** Follows the PR: merged => COMPLETE (gates re-checked by the state machine); failing CI => bounded repair. */
export async function stepPullRequest(d: EngineDeps, runId: string): Promise<PrOutcome> {
  const run = d.store.getRun(runId);
  if (isLocalDelivery(run.prUrl)) {
    const base = await d.git.defaultBranch(d.root);
    if (run.headSha && (await d.git.isAncestor(d.root, run.headSha, base))) {
      d.store.transition(runId, 'COMPLETE', { actor: 'engine', reason: `merged into ${base}` });
      return 'complete';
    }
    return { waiting: 'merge', reason: `local branch ${run.activeBranch} is ready; merge it into ${base} (no pull request: GitHub disabled)` };
  }
  const pr = await d.port!.getPullRequest(run.prUrl!);
  if (pr.state === 'MERGED') {
    d.store.transition(runId, 'COMPLETE', { actor: 'engine', reason: 'pull request merged' });
    return 'complete';
  }
  if (pr.state === 'CLOSED') {
    await block(d, runId, 'pull request was closed without merging');
    return 'blocked';
  }
  if (pr.checks === 'failure') {
    d.store.setKey(`repair-notes:${runId}`, `Required CI checks failed on ${run.prUrl}. Inspect the failing checks and fix the cause.`);
    if (run.repairCount >= run.repairBudget) {
      await block(d, runId, 'CI failed and the repair budget is exhausted');
      return 'blocked';
    }
    d.store.transition(runId, 'REPAIRING', { actor: 'engine', reason: 'CI checks failed' });
    return 'repair';
  }
  return { waiting: 'merge', reason: `PR is open (checks: ${pr.checks}); awaiting human review and merge` };
}
