import { basename } from 'node:path';
import { gateReport } from '../gates/runner';
import { IncidentRepo } from '../memory/incidents';
import { memoryForPrompt, retrieveMemory } from '../memory/retrieve';
import type { EvidenceReference, HistoricalMemoryResult } from '../memory/types';
import type { Plan } from '../plan/schema';
import type { GateResultRow, TaskRun } from '../state/store';
import { type EngineDeps, clockOf } from './deps';
import { block } from './steps-plan';

const INCIDENT_PROTOCOLS = new Set(['bug', 'troubleshooting']);
const memoryKey = (runId: string): string => `memory:${runId}`;

export const incidentsOf = (d: EngineDeps): IncidentRepo => new IncidentRepo(d.store.db, clockOf(d));
export const repositoryIdOf = async (d: EngineDeps): Promise<string> => d.config.github.repo ?? (await d.git.remoteRepo(d.root)) ?? basename(d.root);

export function storedMemory(d: EngineDeps, runId: string): HistoricalMemoryResult | null {
  const raw = d.store.getKey(memoryKey(runId));
  return raw ? (JSON.parse(raw) as HistoricalMemoryResult) : null;
}

/** Text the planner receives; empty for runs that predate memory so old state keeps working. */
export function memoryContext(d: EngineDeps, runId: string): string | undefined {
  const m = storedMemory(d, runId);
  return m ? memoryForPrompt(m) : undefined;
}

async function ensureIncident(d: EngineDeps, run: TaskRun): Promise<void> {
  if (!INCIDENT_PROTOCOLS.has(run.protocolId)) return;
  const repo = incidentsOf(d);
  const url = run.sourceIssueNumber && d.config.github.repo ? `https://github.com/${d.config.github.repo}/issues/${run.sourceIssueNumber}` : undefined;
  repo.create({ taskRunId: run.id, repositoryId: await repositoryIdOf(d), title: run.intent.slice(0, 120), summary: run.intent, githubIssueNumber: run.sourceIssueNumber ?? undefined, githubIssueUrl: url, baseRevision: run.baseCommit ?? (await d.git.head(d.root)), symptoms: [run.intent] }, 'engine');
  repo.setStatus(repo.forRun(run.id)!, 'INVESTIGATING', 'engine');
}

async function retrieveWithRetries(d: EngineDeps, run: TaskRun): Promise<{ result: HistoricalMemoryResult; attempts: number }> {
  const repositoryId = await repositoryIdOf(d);
  const head = await d.git.head(d.root).catch(() => null);
  const input = { taskId: run.id, repositoryId, intent: run.intent, issueNumber: run.sourceIssueNumber ?? undefined, headRevision: head };
  const deps = { incidents: incidentsOf(d), port: d.port, root: d.root, nowIso: () => clockOf(d).nowIso(), maxResults: d.config.memory.maxResults, changedSince: (rev: string) => d.git.changedFiles(d.root, rev).catch(() => null) };
  let attempts = 0;
  let result = await retrieveMemory(input, deps);
  while (result.completeness !== 'complete' && attempts < d.config.memory.retries) {
    attempts++;
    d.store.audit(run.id, 'memory.retry', 'engine', { attempt: attempts, completeness: result.completeness, warnings: result.warnings });
    result = await retrieveMemory(input, deps);
  }
  return { result, attempts: attempts + 1 };
}

/**
 * RETRIEVING_MEMORY: load history, persist the result, then plan. Re-running after a crash is safe: a stored result is
 * reused, and the incident and its entries are keyed so nothing is duplicated.
 */
export async function stepMemory(d: EngineDeps, runId: string): Promise<void> {
  const run = d.store.getRun(runId);
  if (storedMemory(d, runId)) {
    d.store.transition(runId, 'PLANNING', { actor: 'engine' });
    return;
  }
  const step = d.store.beginStep(runId, 'memory');
  await ensureIncident(d, run);
  const { result, attempts } = await retrieveWithRetries(d, run);
  d.store.setKey(memoryKey(runId), JSON.stringify(result));
  d.store.audit(runId, 'memory.retrieved', 'engine', { completeness: result.completeness, attempts, incidents: result.relatedIncidents.length, issues: result.relatedIssues.length, pullRequests: result.relatedPullRequests.length, sources: result.sources, warnings: result.warnings });
  if (result.completeness !== 'complete' && d.config.memory.requireComplete) {
    d.store.setKey(memoryKey(runId), '');
    d.store.finishStep(step.id, { state: 'FAILED', errorCategory: 'memory' });
    return block(d, runId, `historical memory is ${result.completeness} and memory.requireComplete is set: ${result.warnings.join(' ')}`);
  }
  d.store.finishStep(step.id, { state: 'DONE' });
  d.store.transition(runId, 'PLANNING', { actor: 'engine' });
}

const STATUS_OF_STATE: Partial<Record<TaskRun['state'], 'INVESTIGATING' | 'FIX_IN_PROGRESS' | 'VERIFIED' | 'CLOSED'>> = {
  DISCOVERING: 'INVESTIGATING', RETRIEVING_MEMORY: 'INVESTIGATING', PLANNING: 'INVESTIGATING', AWAITING_APPROVAL: 'INVESTIGATING',
  READY: 'FIX_IN_PROGRESS', RUNNING: 'FIX_IN_PROGRESS', VERIFYING: 'FIX_IN_PROGRESS', REPAIRING: 'FIX_IN_PROGRESS',
  REVIEW_REQUIRED: 'VERIFIED', PR_OPEN: 'VERIFIED', COMPLETE: 'CLOSED',
};

const ref = (type: string, description: string, commitSha?: string, artifactId?: string): EvidenceReference => ({ type, description, ...(commitSha ? { commitSha } : {}), ...(artifactId ? { artifactId } : {}), recordedAt: new Date(0).toISOString() });

function evidenceRefs(d: EngineDeps, runId: string, rows: GateResultRow[]): EvidenceReference[] {
  return rows.flatMap((g) => g.evidenceIds.map((id) => ({ ...ref('gate-evidence', `${g.gateId}=${g.state}`, g.commitSha, id), recordedAt: g.finishedAtUtc })));
}

/** Brings the incident in line with what the run has durably recorded. Idempotent; called as the run advances. */
export function syncIncident(d: EngineDeps, runId: string): void {
  const repo = incidentsOf(d);
  const id = repo.forRun(runId);
  if (!id) return;
  const run = d.store.getRun(runId);
  const plan = d.store.getPlanBody(runId) as Plan | undefined;
  for (const m of plan?.affectedModules ?? []) repo.link(id, 'affected-file', m.path, 'engine');
  // the planner's own claim of a "confirmed" cause is only another hypothesis until evidence confirms it
  for (const h of new Set([...(plan?.rootCause?.hypotheses ?? []), ...(plan?.rootCause?.confirmed ? [plan.rootCause.confirmed] : [])])) repo.entry(id, `plan-hyp:${h}`, 'hypothesis', 'agent:planner', { id: `plan-${repo.get(id)!.rootCauseHypotheses.length + 1}`, description: h, evidence: [] });
  if (run.headSha) repo.link(id, 'commit', run.headSha, 'engine');
  if (run.prUrl && !run.prUrl.startsWith('local-branch:')) repo.link(id, 'pull-request', run.prUrl, 'engine');
  if (plan?.regressionTest) {
    const last = d.store.gateHistory(runId, 'regression-test').filter((g) => g.commitSha === run.headSha).at(-1);
    repo.addRegressionTest(id, { name: basename(plan.regressionTest.file), filePath: plan.regressionTest.file, command: plan.regressionTest.command, ...(last ? { lastVerifiedRevision: last.commitSha, lastResult: last.state === 'PASS' ? 'PASS' : 'FAIL' } : { lastResult: 'UNKNOWN' }) }, 'engine');
  }
  confirmFromEvidence(d, runId, id);
  const status = STATUS_OF_STATE[run.state];
  if (status && !(repo.get(id)!.status === 'REOPENED' && status === 'INVESTIGATING')) repo.setStatus(id, status, 'engine');
}

/** The only way the engine confirms a root cause: the regression test failed before the fix and passes on the verified head. */
function confirmFromEvidence(d: EngineDeps, runId: string, incidentId: string): void {
  const repo = incidentsOf(d);
  const inc = repo.get(incidentId)!;
  const proof = d.store.gateHistory(runId, 'reproduction-proven').filter((g) => g.state === 'PASS').at(-1);
  const hyp = inc.rootCauseHypotheses.find((h) => h.status === 'UNVERIFIED');
  if (!proof || proof.commitSha !== d.store.getRun(runId).headSha || !hyp || inc.confirmedRootCause) return;
  repo.setHypothesisStatus(incidentId, hyp.id, 'CONFIRMED', 'engine', evidenceRefs(d, runId, [proof]));
}

/** Records how the implementation at one commit fared, with the diagnosis; later attempts never overwrite it. */
export function recordAttempt(d: EngineDeps, runId: string, commitSha: string, outcome: 'SUCCESS' | 'FAILURE', detail: { reason?: string; diagnosis?: string } = {}): void {
  const repo = incidentsOf(d);
  const id = repo.forRun(runId);
  if (!id) return;
  const gates = d.store.gateHistory(runId).filter((g) => g.commitSha === commitSha);
  repo.recordAttempt(id, { id: `commit-${commitSha.slice(0, 8)}`, description: `implementation at ${commitSha.slice(0, 12)}`, outcome, commitSha, failureReason: detail.reason, diagnosis: detail.diagnosis, evidence: evidenceRefs(d, runId, gates) }, 'engine');
}

export const gateSummary = (d: EngineDeps, runId: string): string => gateReport(d.store, runId).gates.map((g) => `${g.gateId}=${g.state}`).join(', ');
