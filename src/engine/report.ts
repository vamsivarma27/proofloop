import { existsSync, readFileSync } from 'node:fs';
import { sha256 } from '../shared/hash';
import { gateReport } from '../gates/runner';
import type { Plan } from '../plan/schema';
import type { Store } from '../state/store';

export interface IntegrityProblem {
  evidenceId: string;
  problem: string;
}

/** Deterministic delivery check: every cited artifact exists, matches its checksum and names the candidate commit. */
export function verifyEvidenceIntegrity(store: Store, runId: string): IntegrityProblem[] {
  const run = store.getRun(runId);
  const problems: IntegrityProblem[] = [];
  const byId = new Map(store.evidenceFor(runId).map((e) => [e.id as string, e]));
  for (const g of gateReport(store, runId).gates.filter((x) => x.required)) {
    if (g.evidence.length === 0) problems.push({ evidenceId: g.gateId, problem: `required gate ${g.gateId} has no evidence` });
    for (const id of g.evidence) {
      const e = byId.get(id);
      if (!e) {
        problems.push({ evidenceId: id, problem: 'evidence record missing' });
        continue;
      }
      if (e.commit_sha !== run.headSha) problems.push({ evidenceId: id, problem: `evidence is for ${String(e.commit_sha).slice(0, 8)}, not the candidate ${run.headSha?.slice(0, 8)}` });
      const uri = String(e.uri);
      if (!existsSync(uri)) problems.push({ evidenceId: id, problem: `artifact file missing: ${uri}` });
      else if (sha256(readFileSync(uri)) !== e.checksum) problems.push({ evidenceId: id, problem: `checksum mismatch for ${uri}` });
    }
  }
  return problems;
}

export function renderReport(store: Store, runId: string, opts: { forPr?: boolean } = {}): string {
  const run = store.getRun(runId);
  const rep = gateReport(store, runId);
  const plan = store.getPlanBody(runId) as (Partial<Plan> & { idea?: { oneLine: string } }) | undefined;
  const history = store.events(runId, 'transition');
  const L: string[] = [];
  L.push(`# ProofLoop report — ${run.protocolId} (${run.id})`, '', `- State: **${run.state}**${run.blockedReason ? ` — ${run.blockedReason}` : ''}`, `- Protocol: ${run.protocolId}@${run.protocolVersion}, engine ${run.engineVersion}`, `- Risk: ${run.risk}`);
  L.push(`- Base: \`${run.baseCommit?.slice(0, 12) ?? 'n/a'}\`, candidate: \`${run.headSha?.slice(0, 12) ?? 'n/a'}\`, branch: \`${run.activeBranch ?? 'n/a'}\``);
  L.push(`- Plan: v${run.planVersion} \`${run.currentPlanHash?.slice(0, 12) ?? 'none'}\`, approved: ${run.approvedPlanHash === run.currentPlanHash && run.approvedPlanHash ? 'yes' : '**no**'}`, '');
  const intent = plan?.intent?.summary ?? plan?.idea?.oneLine;
  if (intent) L.push(`**Intent:** ${intent}`, '');
  L.push('## Gates (results refer to the candidate commit)', '', '| Gate | Required | Result | Evidence |', '|---|---|---|---|');
  for (const g of rep.gates) L.push(`| ${g.gateId} | ${g.required ? 'yes' : 'no'} | ${g.state}${g.stale ? ' (stale)' : ''} | ${g.evidence.length} artifact(s) |`);
  L.push('', rep.allRequiredPass ? 'All required gates PASS on the candidate commit.' : '**Not all required gates pass. This work is not verified.**');
  const limits = limitations(store, runId, plan);
  if (limits.length) L.push('', '## Known limitations and open items', ...limits.map((x) => `- ${x}`));
  if (!opts.forPr) {
    L.push('', '## State history', ...history.map((h) => `- ${h.ts} ${String(h.data.from)} → ${String(h.data.to)}${h.data.reason ? ` (${String(h.data.reason)})` : ''}`));
    const denied = store.events(runId, 'policy.denied');
    if (denied.length) L.push('', '## Denied actions', ...denied.map((d) => `- ${String(d.data.command)} — ${String(d.data.reason)}`));
  }
  if (run.sourceIssueNumber && opts.forPr) L.push('', `Closes #${run.sourceIssueNumber}`);
  return `${L.join('\n')}\n`;
}

type AnyPlan = Partial<Plan> & { assumptions?: Array<{ id: string; text: string; confirmed?: boolean; status?: string }> };

export function limitations(store: Store, runId: string, plan?: AnyPlan): string[] {
  const out: string[] = [];
  const rep = gateReport(store, runId);
  for (const g of rep.gates) if (g.state !== 'PASS') out.push(`gate ${g.gateId} is ${g.state}${g.required ? ' (required)' : ''}`);
  for (const a of plan?.assumptions ?? []) if (a.confirmed === false || a.status === 'unconfirmed') out.push(`unconfirmed assumption ${a.id}: ${a.text}`);
  for (const m of plan?.affectedModules ?? []) if (m.status === 'hypothesis') out.push(`impact of ${m.path} was never confirmed`);
  for (const ac of plan?.acceptanceCriteria ?? []) if (ac.manual) out.push(`${ac.id} is verified manually only: ${ac.manual.reason}`);
  for (const e of store.events(runId, 'review.skipped')) out.push(`independent review skipped: ${String(e.data.reason)}`);
  const head = store.getRun(runId).headSha;
  for (const e of store.events(runId, 'review.finding').filter((x) => x.data.commit === head)) out.push(`reviewer finding (${String(e.data.severity)}): ${String(e.data.summary)}`);
  for (const e of store.events(runId, 'scope.reverted')) out.push(`out-of-scope edits were reverted: ${(e.data.files as string[]).join(', ')}`);
  return out;
}
