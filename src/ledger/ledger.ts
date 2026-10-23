import { gateReport } from '../gates/runner';
import { IncidentRepo } from '../memory/incidents';
import type { HistoricalMemoryResult, IncidentRecord } from '../memory/types';
import type { Plan } from '../plan/schema';
import { redactValue } from '../shared/redact';
import { ENGINE_GATE_IDS } from '../state/machine';
import type { Store, TaskRun } from '../state/store';

export const LEDGER_SCHEMA_VERSION = 1;
export type CriterionStatus = 'PASS' | 'FAIL' | 'NOT_RUN' | 'BLOCKED' | 'NOT_APPLICABLE';
export type Disposition = 'COMPLETED' | 'READY_FOR_REVIEW' | 'NOT_READY_FOR_COMPLETION' | 'BLOCKED' | 'CANCELLED' | 'IN_PROGRESS';

export interface VerificationRecord {
  gateId: string;
  required: boolean;
  result: 'PASS' | 'FAIL' | 'BLOCKED';
  command: string;
  testedCommit: string;
  startedAt: string;
  finishedAt: string;
  failure: string | null;
  evidence: Array<{ id: string; kind: string; checksum: string; commit: string | null }>;
  /** False when the tested commit is not the current head: stale results are never proof for the head. */
  currentForHead: boolean;
}

export interface CriterionRecord {
  id: string;
  text: string;
  status: CriterionStatus;
  /** gate-level: status is the worst required repository gate on the head commit, not a per-test mapping. */
  basis: string;
  testedCommit: string | null;
}

export interface ProofLedger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  task: { id: string; repository: string | null; githubIssue: { number: number } | null; protocol: string; intent: string; state: string; risk: string; baseRevision: string | null; headRevision: string | null; branch: string | null };
  acceptanceCriteria: CriterionRecord[];
  investigation: { memory: Pick<HistoricalMemoryResult, 'completeness' | 'retrievedAt' | 'retrievedAtRevision' | 'sources' | 'warnings' | 'relatedIncidents' | 'relatedIssues' | 'relatedPullRequests' | 'relevantDecisions'> | null; incident: IncidentRecord | null; assumptions: Array<{ id: string; text: string; confirmed: boolean }>; hypotheses: string[]; confirmedRootCause: string | null };
  implementation: { plan: { version: number; hash: string | null; approved: boolean }; approvals: Array<{ scope: string; by: string; decision: string; planHash: string | null; at: string }>; workers: Array<{ id: string; title: string; state: string; assignedWorker: string | null }>; changedFiles: string[]; commits: string[]; attempts: IncidentRecord['attemptedFixes'] };
  verification: VerificationRecord[];
  events: Array<{ n: number; ts: string; kind: string; actor: string; data: Record<string, unknown> }>;
  assessment: { verified: string[]; failed: string[]; unverified: string[]; staleEvidence: string[]; missingEvidence: string[]; remainingRisks: string[]; blockers: string[]; pullRequestUrl: string | null; disposition: Disposition; reason: string };
}

export interface LedgerOptions {
  /** Files changed between base and head; the engine does not store these, so the caller resolves them from Git. */
  changedFiles?: string[];
  memory?: HistoricalMemoryResult | null;
  repository?: string | null;
}

const NON_ENGINE = (id: string): boolean => !ENGINE_GATE_IDS.includes(id);

function verificationRows(store: Store, run: TaskRun): VerificationRecord[] {
  const evidence = new Map(store.evidenceFor(run.id).map((e) => [e.id as string, e]));
  return store.gateHistory(run.id).map((g) => ({
    gateId: g.gateId, required: g.required, result: g.state, command: g.commandOrAssertion, testedCommit: g.commitSha, startedAt: g.startedAtUtc, finishedAt: g.finishedAtUtc,
    failure: g.state === 'PASS' ? null : (g.failureCategory ?? 'unclassified'), currentForHead: g.commitSha === run.headSha,
    evidence: g.evidenceIds.map((id) => ({ id, kind: String(evidence.get(id)?.kind ?? 'missing'), checksum: String(evidence.get(id)?.checksum ?? ''), commit: (evidence.get(id)?.commit_sha as string | null) ?? null })),
  }));
}

/** Gate-level mapping, stated as such: a criterion is PASS only when every required repository gate passes on the head commit. */
function criteria(store: Store, run: TaskRun, plan: Plan | undefined): CriterionRecord[] {
  const gates = gateReport(store, run.id).gates.filter((g) => g.required && NON_ENGINE(g.gateId));
  const worst: CriterionStatus = gates.some((g) => g.state === 'FAIL' && !g.stale) ? 'FAIL' : gates.some((g) => g.state === 'BLOCKED' && !g.stale) ? 'BLOCKED' : gates.length > 0 && gates.every((g) => g.state === 'PASS' && !g.stale) ? 'PASS' : 'NOT_RUN';
  return (plan?.acceptanceCriteria ?? []).map((ac) => {
    if (ac.manual && ac.tests.length === 0) return { id: ac.id, text: ac.text, status: 'NOT_RUN' as const, basis: `manual only: ${ac.manual.reason}`, testedCommit: null };
    return { id: ac.id, text: ac.text, status: worst, basis: `gate-level: ${gates.map((g) => `${g.gateId}=${g.stale ? 'stale' : g.state}`).join(', ') || 'no required repository gate'}`, testedCommit: worst === 'NOT_RUN' ? null : run.headSha };
  });
}

function assess(run: TaskRun, crit: CriterionRecord[], rows: VerificationRecord[], store: Store): ProofLedger['assessment'] {
  const rep = gateReport(store, run.id);
  // stale = a required gate whose latest result is for an earlier commit; superseded history is not stale evidence
  const latest = new Map(rows.map((r) => [r.gateId, r]));
  const stale = [...latest.values()].filter((r) => r.required && !r.currentForHead).map((r) => `${r.gateId}@${r.testedCommit.slice(0, 8)}`);
  const missing = rep.gates.filter((g) => g.required && g.state === 'MISSING').map((g) => `required gate ${g.gateId} has no result`).concat(rep.gates.filter((g) => g.required && g.state !== 'MISSING' && g.evidence.length === 0).map((g) => `required gate ${g.gateId} has no evidence artifact`));
  const manual = crit.filter((c) => c.status === 'NOT_RUN' && c.basis.startsWith('manual only'));
  const failed = crit.filter((c) => c.status === 'FAIL' || c.status === 'BLOCKED');
  const unverified = crit.filter((c) => c.status === 'NOT_RUN');
  const base = { verified: crit.filter((c) => c.status === 'PASS').map((c) => c.id), failed: failed.map((c) => c.id), unverified: unverified.map((c) => c.id), staleEvidence: stale, missingEvidence: missing, remainingRisks: [] as string[], blockers: run.blockedReason ? [run.blockedReason] : [], pullRequestUrl: run.prUrl && !run.prUrl.startsWith('local-branch:') ? run.prUrl : null };
  for (const c of unverified) base.remainingRisks.push(`${c.id} is not verified: ${c.basis}`);
  for (const s of stale) base.remainingRisks.push(`${s} was tested on an earlier commit and does not support the current head`);
  const notReady = failed.length > 0 || (unverified.length > manual.length) || !rep.allRequiredPass || stale.length > 0 || missing.length > 0;
  const [disposition, reason] = disposeOf(run, notReady, manual.length > 0, failed.length + stale.length + missing.length);
  return { ...base, disposition, reason };
}

function disposeOf(run: TaskRun, notReady: boolean, manualOpen: boolean, problems: number): [Disposition, string] {
  if (run.state === 'CANCELLED') return ['CANCELLED', 'the task was cancelled'];
  if (run.state === 'BLOCKED') return ['BLOCKED', run.blockedReason ?? 'blocked'];
  if (notReady) return [run.state === 'COMPLETE' || run.state === 'PR_OPEN' || run.state === 'REVIEW_REQUIRED' ? 'NOT_READY_FOR_COMPLETION' : 'IN_PROGRESS', problems > 0 ? 'required criteria failed, are unverified, or rest on stale or missing evidence' : 'required gates do not all pass on the current head'];
  if (manualOpen) return ['READY_FOR_REVIEW', 'machine verification is complete; some criteria are manual-only and need a human to confirm them'];
  if (run.state === 'COMPLETE') return ['COMPLETED', 'every criterion is verified on the head commit'];
  return run.state === 'REVIEW_REQUIRED' || run.state === 'PR_OPEN' ? ['READY_FOR_REVIEW', 'all required gates pass on the head commit'] : ['IN_PROGRESS', `work is in state ${run.state}`];
}

/** Built only from persisted state; calling it twice on the same state yields the same document. */
export function buildLedger(store: Store, runId: string, opts: LedgerOptions = {}): ProofLedger {
  const run = store.getRun(runId);
  const plan = store.getPlanBody(runId) as (Plan & { assumptions?: Plan['assumptions'] }) | undefined;
  const incidents = new IncidentRepo(store.db);
  const incident = ((id) => (id ? incidents.get(id) : null))(incidents.forRun(runId));
  const rows = verificationRows(store, run);
  const crit = criteria(store, run, plan);
  const ledger: ProofLedger = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    task: { id: run.id, repository: opts.repository ?? null, githubIssue: run.sourceIssueNumber ? { number: run.sourceIssueNumber } : null, protocol: run.protocolId, intent: run.intent, state: run.state, risk: run.risk, baseRevision: run.baseCommit, headRevision: run.headSha, branch: run.activeBranch },
    acceptanceCriteria: crit,
    investigation: {
      memory: opts.memory ? { completeness: opts.memory.completeness, retrievedAt: opts.memory.retrievedAt, retrievedAtRevision: opts.memory.retrievedAtRevision, sources: opts.memory.sources, warnings: opts.memory.warnings, relatedIncidents: opts.memory.relatedIncidents, relatedIssues: opts.memory.relatedIssues, relatedPullRequests: opts.memory.relatedPullRequests, relevantDecisions: opts.memory.relevantDecisions } : null,
      incident, assumptions: (plan?.assumptions ?? []).map((a) => ({ id: a.id, text: a.text, confirmed: a.confirmed })),
      hypotheses: incident?.rootCauseHypotheses.map((h) => `[${h.status}] ${h.description}`) ?? plan?.rootCause?.hypotheses ?? [], confirmedRootCause: incident?.confirmedRootCause ?? null,
    },
    implementation: {
      plan: { version: run.planVersion, hash: run.currentPlanHash, approved: Boolean(run.approvedPlanHash && run.approvedPlanHash === run.currentPlanHash) },
      approvals: store.approvals(runId).map((a) => ({ scope: String(a.scope), by: String(a.approved_by), decision: String(a.decision), planHash: (a.plan_hash as string | null) ?? null, at: String(a.created_at_utc) })),
      workers: store.nodes(runId).map((n) => ({ id: n.id, title: n.title, state: n.state, assignedWorker: null })),
      changedFiles: [...(opts.changedFiles ?? [])].sort(), commits: incident?.relatedCommits ?? (run.headSha ? [run.headSha] : []), attempts: incident?.attemptedFixes ?? [],
    },
    verification: rows,
    events: store.events(runId).map((e, i) => ({ n: i + 1, ts: e.ts, kind: e.kind, actor: e.actor, data: e.data })),
    assessment: assess(run, crit, rows, store),
  };
  if (!opts.changedFiles) ledger.assessment.missingEvidence.push('changed files were not resolved from Git for this export');
  return redactValue(ledger);
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const sha = (s: string | null): string => (s ? s.slice(0, 8) : 'n/a');

export function renderLedgerMarkdown(l: ProofLedger): string {
  const L: string[] = ['# ProofLoop Proof Ledger', '', `Schema v${l.schemaVersion}`, '', '## Task', '', `- Task: ${l.task.id}`, `- GitHub issue: ${l.task.githubIssue ? `#${l.task.githubIssue.number}` : 'none'}`, `- Protocol: ${l.task.protocol} (risk ${l.task.risk})`, `- Status: ${l.task.state}`, `- Base revision: ${sha(l.task.baseRevision)}`, `- Head revision: ${sha(l.task.headRevision)}`, `- Intent: ${cell(l.task.intent)}`, ''];
  L.push('## Historical context', '');
  const m = l.investigation.memory;
  if (!m) L.push('- Historical retrieval was not run for this task.');
  else {
    L.push(`- Retrieval: ${m.completeness} at ${sha(m.retrievedAtRevision)}`);
    for (const i of m.relatedIncidents) L.push(`- Related incident ${i.incidentId} [${i.freshness}]: ${cell(i.title)} — ${cell(i.relevanceReason)}`, ...i.failedApproaches.map((f) => `  - Previously failed: ${cell(f)}`), ...i.regressionTests.map((t) => `  - Regression test: ${t.name}`));
    for (const x of [...m.relatedIssues, ...m.relatedPullRequests]) L.push(`- #${x.number} ${cell(x.title)} (${x.state})`);
    for (const w of m.warnings) L.push(`- Warning: ${cell(w)}`);
  }
  L.push('', '## Investigation', '', ...(l.investigation.hypotheses.length ? l.investigation.hypotheses.map((h) => `- Hypothesis ${cell(h)}`) : ['- No hypotheses recorded.']), `- Confirmed root cause: ${l.investigation.confirmedRootCause ? cell(l.investigation.confirmedRootCause) : 'none confirmed'}`, ...l.investigation.assumptions.map((a) => `- Assumption ${a.id} (${a.confirmed ? 'confirmed' : 'unconfirmed'}): ${cell(a.text)}`));
  L.push('', '## Implementation', '', `- Plan v${l.implementation.plan.version}, ${l.implementation.plan.approved ? 'approved' : 'not approved'}`, ...l.implementation.approvals.map((a) => `- Approval: ${a.decision} by ${a.by} (${a.scope})`), `- Commits: ${l.implementation.commits.map(sha).join(', ') || 'none'}`, '- Changed files:', ...(l.implementation.changedFiles.length ? l.implementation.changedFiles.map((f) => `  - ${f}`) : ['  - (not resolved)']));
  L.push('', '### Attempts', '', ...(l.implementation.attempts.length ? l.implementation.attempts.map((a) => `- ${a.id}: ${a.outcome}${a.failureReason ? ` — ${cell(a.failureReason)}` : ''}${a.diagnosis ? ` (diagnosis: ${cell(a.diagnosis)})` : ''}`) : ['- none recorded']));
  L.push('', '## Verification', '', '| Criterion | Result | Revision | Basis |', '|---|---|---|---|', ...l.acceptanceCriteria.map((c) => `| ${c.id} | ${c.status} | ${sha(c.testedCommit)} | ${cell(c.basis)} |`));
  L.push('', '| Check | Result | Tested commit | Current for head |', '|---|---|---|---|', ...l.verification.map((v) => `| ${v.gateId} | ${v.result} | ${sha(v.testedCommit)} | ${v.currentForHead ? 'yes' : '**no (stale)**'} |`));
  const a = l.assessment;
  L.push('', '## Remaining risks', '', ...(a.remainingRisks.length ? a.remainingRisks.map((r) => `- ${cell(r)}`) : ['- none recorded']), ...a.missingEvidence.map((r) => `- Missing evidence: ${cell(r)}`));
  L.push('', '## Disposition', '', a.disposition.replace(/_/g, ' '), '', `Reason: ${cell(a.reason)}`, ...(a.pullRequestUrl ? ['', `Pull request: ${a.pullRequestUrl}`] : []));
  return `${L.join('\n')}\n`;
}

/** Short form for a GitHub comment or PR body; the full ledger stays in `proofloop ledger export`. */
export function renderLedgerSummary(l: ProofLedger): string {
  const a = l.assessment;
  return [`**Proof Ledger** — ${a.disposition.replace(/_/g, ' ')} (head \`${sha(l.task.headRevision)}\`)`, `- Verified: ${a.verified.join(', ') || 'none'}`, `- Failed: ${a.failed.join(', ') || 'none'}`, `- Unverified: ${a.unverified.join(', ') || 'none'}`, ...(a.staleEvidence.length ? [`- Stale evidence: ${a.staleEvidence.join(', ')}`] : []), `- Reason: ${cell(a.reason)}`, `- Full ledger: \`proofloop ledger export ${l.task.id} --format markdown\``].join('\n');
}
