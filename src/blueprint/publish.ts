import { topoSort } from '../plan/dag';
import { PlError } from '../shared/errors';
import type { GithubPort, IssueRef } from '../github/adapter';
import type { Store } from '../state/store';
import type { Blueprint } from './schema';

export interface PublishResult {
  issues: Record<string, IssueRef>;
  links: { sub: 'linked' | 'unsupported' | 'none'; blockedBy: 'linked' | 'unsupported' | 'none' };
}

const body = (bp: Blueprint, m: Blueprint['roadmap']['milestones'][number], blockers: string): string =>
  `${m.goal}\n\n**Features:** ${m.featureIds.join(', ')}\n\n**Acceptance criteria**\n${m.acceptanceCriteria.map((a) => `- [ ] ${a}`).join('\n')}\n\n**Verification:** ${m.verification}\n${blockers}\n${m.assumptionIds.length ? `\n**Rests on assumptions (confirm):** ${m.assumptionIds.map((a) => bp.assumptions.find((x) => x.id === a)?.text ?? a).join('; ')}\n` : ''}`;

/**
 * Bulk issue creation. Refuses unless the exact blueprint hash was approved by a human, so nothing is created
 * from an unreviewed or edited blueprint. Idempotent: re-running reuses issues by marker.
 */
export async function publishRoadmap(store: Store, port: GithubPort, runId: string, bp: Blueprint): Promise<PublishResult> {
  const run = store.getRun(runId);
  if (!run.approvedPlanHash || run.approvedPlanHash !== run.currentPlanHash)
    throw new PlError('PL_BLUEPRINT_001', 'the current blueprint has not been approved; refusing to create issues');
  const parent = await port.ensureIssue(`run/${runId}`, `[roadmap] ${bp.idea.oneLine}`.slice(0, 120), `${bp.idea.outcome}\n\nRoadmap for this product. Milestones are linked as sub-issues.`, ['roadmap']);
  const issues: Record<string, IssueRef> = {};
  const ordered = topoSort(bp.roadmap.milestones);
  let sub: PublishResult['links']['sub'] = 'none';
  let blockedBy: PublishResult['links']['blockedBy'] = 'none';
  for (const m of ordered) {
    const blockers = m.dependencies.length ? `\n**Blocked by:** ${m.dependencies.map((d) => (issues[d] ? `#${issues[d]!.number}` : d)).join(', ')}\n` : '';
    issues[m.id] = await port.ensureIssue(`run/${runId}/milestone/${m.id}`, `${m.id}: ${m.title}`, body(bp, m, blockers), ['milestone']);
    sub = await port.linkSubIssue(parent, issues[m.id]!);
    for (const d of m.dependencies) blockedBy = await port.blockedBy(issues[m.id]!, issues[d]!);
  }
  store.setKey(`roadmap:${runId}`, JSON.stringify({ parent, issues }));
  store.audit(runId, 'roadmap.published', 'engine', { milestones: ordered.length, sub, blockedBy });
  return { issues: { parent, ...issues }, links: { sub, blockedBy } };
}
