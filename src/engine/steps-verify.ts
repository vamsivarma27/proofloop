import { readFileSync } from 'node:fs';
import { gateReport, runGates } from '../gates/runner';
import { getPlan } from '../plan/workflow';
import { classifyRisk } from '../policy/risk';
import { riskRank } from '../protocol/schema';
import { ENGINE_GATE_IDS } from '../state/machine';
import type { GateResultRow, TaskRun } from '../state/store';
import { redact } from '../shared/redact';
import { ROUTE, classifyFailure } from './classify';
import { type EngineDeps, callAgent, commitType, gateCtx, implementerTools } from './deps';
import { type Findings, findingsJsonSchema, findingsSchema, repairPrompt, reviewerPrompt } from './prompts';
import { verifyEvidenceIntegrity } from './report';
import { enforceScopeFor } from './scope';
import { block, currentGateEntries, syncGatePlan } from './steps-plan';

const LOG_TAIL_LINES = 60;

function logTail(d: EngineDeps, r: GateResultRow): string {
  const ev = d.store.evidenceFor(r.taskRunId).find((e) => r.evidenceIds.includes(e.id as string) && e.kind === 'gate-log');
  if (!ev) return '(no log)';
  try {
    return readFileSync(String(ev.uri), 'utf8').split('\n').slice(-LOG_TAIL_LINES).join('\n');
  } catch {
    return '(log unreadable)';
  }
}

const summarize = (d: EngineDeps, rows: GateResultRow[]): string => rows.map((r) => `### gate ${r.gateId}: ${r.state}${r.failureCategory ? ` (${r.failureCategory})` : ''}\ncommand: ${r.commandOrAssertion}\n${logTail(d, r)}`).join('\n\n');

async function commitPending(d: EngineDeps, run: TaskRun, cwd: string): Promise<string> {
  if (!(await d.git.isClean(cwd))) await d.git.commitAll(cwd, `${commitType(run.protocolId)}: apply pending changes`);
  return d.git.head(cwd);
}

/** Raises (never lowers) risk from what actually changed, which may add stricter gates. */
async function escalateRisk(d: EngineDeps, run: TaskRun, cwd: string): Promise<void> {
  const files = await d.git.changedFiles(cwd, run.baseCommit!);
  const before = d.store.getRun(run.id).risk;
  const after = d.store.raiseRisk(run.id, classifyRisk(files)).risk;
  if (riskRank(after) > riskRank(before)) syncGatePlan(d, run.id);
}

export async function stepVerify(d: EngineDeps, runId: string): Promise<void> {
  const run = d.store.getRun(runId);
  const cwd = run.worktreePath!;
  const head = await commitPending(d, run, cwd);
  d.store.setFields(runId, { headSha: head });
  await escalateRisk(d, run, cwd);
  const step = d.store.beginStep(runId, 'verify');
  const results = await runGates(gateCtx(d, runId, cwd, head), currentGateEntries(d, runId));
  d.store.finishStep(step.id, { state: 'DONE' });
  const rep = gateReport(d.store, runId);
  await d.github.checkpoint(runId, `verify-${head.slice(0, 8)}`, `Verification on \`${head.slice(0, 12)}\`:\n\n${rep.gates.map((g) => `- ${g.gateId}: **${g.state}**${g.required ? '' : ' (optional)'}`).join('\n')}`);
  if (rep.allRequiredPass) {
    d.store.transition(runId, 'REVIEW_REQUIRED', { actor: 'engine' });
    return;
  }
  const failing = results.filter((r) => r.required && r.state !== 'PASS');
  if (rep.gates.every((g) => !g.required || ENGINE_GATE_IDS.includes(g.gateId))) return block(d, runId, `no required gate can run: ${unsupportedList(d, runId)}. A missing test is not a pass; set commands in .proofloop/config.json`);
  await routeFailure(d, runId, failing);
}

const unsupportedList = (d: EngineDeps, runId: string): string => currentGateEntries(d, runId).filter((e) => e.unsupported).map((e) => e.gateId).join(', ') || 'none planned';

async function routeFailure(d: EngineDeps, runId: string, failing: GateResultRow[]): Promise<void> {
  const classified = failing.map((r) => ({ r, cat: classifyFailure({ category: r.failureCategory, output: logTail(d, r), history: d.store.gateHistory(runId, r.gateId), commitSha: r.commitSha }) }));
  const desc = classified.map(({ r, cat }) => `${r.gateId}=${r.state}/${cat}`).join(', ');
  const unrepairable = classified.some(({ r, cat }) => r.state === 'BLOCKED' || ROUTE[cat] !== 'repair');
  if (unrepairable) return block(d, runId, `cannot be fixed by editing code: ${desc}`);
  const fp = failing.map((r) => `${r.gateId}:${r.fingerprint ?? ''}`).sort().join('|');
  if (d.store.getKey(`fp:${runId}`) === fp) return block(d, runId, `identical failure repeated with no new evidence: ${desc}`);
  d.store.setKey(`fp:${runId}`, fp);
  d.store.setKey(`repair-notes:${runId}`, summarize(d, failing));
  return enterRepair(d, runId, `repair budget exhausted; failing: ${desc}`);
}

async function enterRepair(d: EngineDeps, runId: string, exhausted: string): Promise<void> {
  const run = d.store.getRun(runId);
  if (run.repairCount >= run.repairBudget) return block(d, runId, exhausted);
  d.store.transition(runId, 'REPAIRING', { actor: 'engine', reason: `attempt ${run.repairCount + 1}/${run.repairBudget}` });
}

/** Resumes the implementer session with the failure evidence; never edits outside the approved plan's scopes. */
export async function stepRepair(d: EngineDeps, runId: string): Promise<void> {
  const run = d.store.getRun(runId);
  const plan = getPlan(d.store, runId);
  const step = d.store.beginStep(runId, 'repair');
  const res = await callAgent(d, run, { role: 'implementer', cwd: run.worktreePath!, resumeSessionId: d.store.getKey(`session:${runId}`), allowedTools: implementerTools(d, runId), prompt: repairPrompt({ plan, notes: d.store.getKey(`repair-notes:${runId}`) ?? 'no notes recorded', attempt: run.repairCount }) });
  if (!res.ok) {
    d.store.finishStep(step.id, { state: 'FAILED', errorCategory: 'agent' });
    return block(d, runId, `repair agent failed: ${res.error}`);
  }
  if (res.sessionId) d.store.setKey(`session:${runId}`, res.sessionId);
  const scopes = plan.tasks.flatMap((t) => t.fileScopes);
  await enforceScopeFor(d, run, run.worktreePath!, scopes);
  await d.git.commitAll(run.worktreePath!, `fix: address failing checks (attempt ${run.repairCount})`);
  d.store.finishStep(step.id, { state: 'DONE' });
  d.store.transition(runId, 'RUNNING', { actor: 'engine' });
}

const needsReview = (d: EngineDeps, run: TaskRun): boolean => {
  const phase = d.registry.get(run.protocolId).phases.find((p) => p.id === 'review');
  return Boolean(phase && !phase.skipped) && riskRank(run.risk) >= riskRank('medium');
};

/** Fresh-context, read-only reviewers. A review that cannot run blocks (never silently passes) for medium+ risk. */
export async function stepReview(d: EngineDeps, runId: string): Promise<'approved' | 'handled'> {
  const run = d.store.getRun(runId);
  const problems = verifyEvidenceIntegrity(d.store, runId);
  if (problems.length) {
    await block(d, runId, `evidence integrity check failed: ${problems.map((p) => p.problem).join('; ')}`);
    return 'handled';
  }
  if (d.store.getKey(`reviewed:${runId}`) === run.headSha) return 'approved';
  if (!needsReview(d, run)) {
    d.store.audit(runId, 'review.skipped', 'engine', { reason: `risk ${run.risk}: protocol review not required` });
    return 'approved';
  }
  const roles = riskRank(run.risk) >= riskRank('high') || run.protocolId === 'security' ? (['reviewer', 'security-reviewer'] as const) : (['reviewer'] as const);
  const notes: string[] = [];
  for (const role of roles) {
    const out = await runReviewer(d, run, role);
    if (out === 'failed') return 'handled';
    notes.push(...out);
  }
  if (notes.length === 0) {
    d.store.setKey(`reviewed:${runId}`, run.headSha!);
    return 'approved';
  }
  d.store.setKey(`repair-notes:${runId}`, `Reviewer findings:\n${notes.join('\n')}`);
  await enterRepair(d, runId, `review requested changes and repair budget is exhausted: ${notes.join('; ').slice(0, 300)}`);
  return 'handled';
}

async function runReviewer(d: EngineDeps, run: TaskRun, role: 'reviewer' | 'security-reviewer'): Promise<string[] | 'failed'> {
  const rep = gateReport(d.store, run.id);
  const gateSummary = rep.gates.map((g) => `${g.gateId}: ${g.state}${g.stale ? ' (stale)' : ''}`).join('\n');
  const diff = await d.git.diff(run.worktreePath!, run.baseCommit!);
  const res = await callAgent(d, run, { role, cwd: run.worktreePath!, jsonSchema: findingsJsonSchema(), prompt: reviewerPrompt({ plan: getPlan(d.store, run.id), diff, gateSummary, role }) });
  const parsed = res.ok ? findingsSchema.safeParse(res.structured) : null;
  if (!parsed?.success) {
    await block(d, run.id, `${role} could not produce a valid review (${res.error ?? 'invalid output'}); an unreviewed change is not delivered`);
    return 'failed';
  }
  return collectFindings(d, run, role, parsed.data);
}

function collectFindings(d: EngineDeps, run: TaskRun, role: string, f: Findings): string[] {
  for (const x of f.findings) d.store.audit(run.id, 'review.finding', `agent:${role}`, { severity: x.severity, file: x.file, line: x.line, summary: redact(x.summary), commit: run.headSha });
  const serious = f.findings.filter((x) => x.severity === 'high' || x.severity === 'critical');
  if (f.verdict === 'approve' && serious.length === 0) return [];
  return (serious.length ? serious : f.findings).map((x) => `[${x.severity}] ${x.file}${x.line ? `:${x.line}` : ''} ${x.summary}`);
}
