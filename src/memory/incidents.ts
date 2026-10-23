import { randomBytes } from 'node:crypto';
import { PlError } from '../shared/errors';
import { type Clock, systemClock } from '../shared/clock';
import { redactValue } from '../shared/redact';
import type { Db } from '../state/db';
import type { AttemptOutcome, EvidenceReference, HypothesisStatus, IncidentAttempt, IncidentRecord, IncidentStatus, RegressionTestReference, RootCauseHypothesis } from './types';

type Row = Record<string, unknown>;
export interface NewIncident {
  taskRunId?: string | null;
  repositoryId: string;
  title: string;
  summary: string;
  githubIssueNumber?: number | undefined;
  githubIssueUrl?: string | undefined;
  baseRevision?: string | undefined;
  supersedes?: string | undefined;
  symptoms?: string[];
  expectedBehavior?: string[];
  actualBehavior?: string[];
  reproductionSteps?: string[];
  environment?: Record<string, string>;
}

const isHuman = (actor: string): boolean => actor.startsWith('human:');

/**
 * Incident records: an immutable header plus append-only entries, folded into an IncidentRecord on read. Every write
 * names a `key`; writing the same key twice is a no-op, so replays after a crash never duplicate history.
 */
export class IncidentRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  private all(sql: string, ...p: Array<string | number | null>): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  private one(sql: string, ...p: Array<string | number | null>): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }

  /** One incident per task run: calling again with the same run returns the existing incident. */
  create(input: NewIncident, actor = 'engine'): string {
    if (input.taskRunId) {
      const existing = this.one('SELECT id FROM incident WHERE task_run_id = ?', input.taskRunId);
      if (existing) return existing.id as string;
    }
    const id = `inc_${randomBytes(5).toString('hex')}`;
    this.db
      .prepare('INSERT INTO incident (id, task_run_id, repository, github_issue_number, github_issue_url, title, summary, base_revision, supersedes, created_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.taskRunId ?? null, input.repositoryId, input.githubIssueNumber ?? null, input.githubIssueUrl ?? null, input.title, input.summary, input.baseRevision ?? null, input.supersedes ?? null, this.clock.nowIso());
    for (const [kind, list] of [['symptom', input.symptoms], ['expected', input.expectedBehavior], ['actual', input.actualBehavior], ['repro', input.reproductionSteps]] as const)
      (list ?? []).forEach((text, i) => this.entry(id, `${kind}:${i}`, kind, actor, { text }));
    for (const [k, v] of Object.entries(input.environment ?? {})) this.entry(id, `env:${k}`, 'environment', actor, { key: k, value: v });
    this.entry(id, 'status:open', 'status', actor, { status: 'OPEN' });
    return id;
  }

  /** Appends one entry. Returns false when the key already exists (an idempotent replay). */
  entry(incidentId: string, key: string, kind: string, actor: string, data: Record<string, unknown>): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO incident_entry (incident_id, key, kind, actor, data, ts_utc) VALUES (?,?,?,?,?,?)')
      .run(incidentId, key, kind, actor, JSON.stringify(redactValue(data)), this.clock.nowIso());
    return Number(r.changes) > 0;
  }

  private requireEvidence(actor: string, evidence: EvidenceReference[], what: string): void {
    if (!isHuman(actor) && evidence.length === 0)
      throw new PlError('PL_INCIDENT_001', `${what} needs recorded evidence or a human decision; an agent's assertion is not enough`);
  }

  addHypothesis(incidentId: string, description: string, actor: string, evidence: EvidenceReference[] = []): string {
    const id = `hyp_${this.all("SELECT 1 FROM incident_entry WHERE incident_id = ? AND kind = 'hypothesis'", incidentId).length + 1}`;
    this.entry(incidentId, `hyp:${id}`, 'hypothesis', actor, { id, description, evidence });
    return id;
  }

  /** Hypotheses start UNVERIFIED. CONFIRMED needs evidence or a `human:*` actor; every change is a new entry. */
  setHypothesisStatus(incidentId: string, hypothesisId: string, status: HypothesisStatus, actor: string, evidence: EvidenceReference[] = []): void {
    if (status === 'CONFIRMED') this.requireEvidence(actor, evidence, 'confirming a root cause');
    const n = this.all("SELECT 1 FROM incident_entry WHERE incident_id = ? AND kind = 'hypothesis-status'", incidentId).length + 1;
    this.entry(incidentId, `hyp-status:${n}`, 'hypothesis-status', actor, { id: hypothesisId, status, evidence });
    if (status === 'CONFIRMED') this.setStatus(incidentId, 'ROOT_CAUSE_IDENTIFIED', actor);
  }

  confirmRootCause(incidentId: string, description: string, actor: string, evidence: EvidenceReference[] = []): void {
    this.requireEvidence(actor, evidence, 'confirming a root cause');
    const n = this.all("SELECT 1 FROM incident_entry WHERE incident_id = ? AND kind = 'root-cause'", incidentId).length + 1;
    this.entry(incidentId, `root-cause:${n}`, 'root-cause', actor, { description, evidence });
    this.setStatus(incidentId, 'ROOT_CAUSE_IDENTIFIED', actor);
  }

  /** Attempts are never overwritten; a later attempt is a new entry, and an outcome change is its own entry. */
  recordAttempt(incidentId: string, a: { id: string; description: string; outcome: AttemptOutcome; commitSha?: string | undefined; failureReason?: string | undefined; diagnosis?: string | undefined; evidence?: EvidenceReference[] }, actor: string): boolean {
    return this.entry(incidentId, `attempt:${a.id}:${a.outcome}`, 'attempt', actor, { ...a, evidence: a.evidence ?? [] });
  }

  addRegressionTest(incidentId: string, t: RegressionTestReference, actor: string): void {
    this.entry(incidentId, `test:${t.name}:${t.lastVerifiedRevision ?? ''}:${t.lastResult ?? ''}`, 'regression-test', actor, { ...t });
  }

  link(incidentId: string, kind: 'commit' | 'pull-request' | 'affected-file', value: string, actor: string): void {
    this.entry(incidentId, `${kind}:${value}`, kind, actor, { value });
  }

  setStatus(incidentId: string, status: IncidentStatus, actor: string): void {
    const cur = this.get(incidentId)?.status;
    if (cur === status) return;
    const n = this.all("SELECT 1 FROM incident_entry WHERE incident_id = ? AND kind = 'status'", incidentId).length + 1;
    this.entry(incidentId, `status:${n}`, 'status', actor, { status });
  }

  /** A regression of a CLOSED/VERIFIED incident reopens it, keeping its history. */
  reopen(incidentId: string, actor: string, reason: string): void {
    this.entry(incidentId, `reopen:${this.all("SELECT 1 FROM incident_entry WHERE incident_id = ? AND kind = 'reopen'", incidentId).length + 1}`, 'reopen', actor, { reason });
    this.setStatus(incidentId, 'REOPENED', actor);
  }

  /** A new incident that points at an earlier one it replaces or recurs from. */
  supersede(oldId: string, input: Omit<NewIncident, 'supersedes'>, actor = 'engine'): string {
    const id = this.create({ ...input, supersedes: oldId }, actor);
    this.entry(oldId, `superseded-by:${id}`, 'superseded', actor, { by: id });
    return id;
  }

  forRun(taskRunId: string): string | null {
    return (this.one('SELECT id FROM incident WHERE task_run_id = ?', taskRunId)?.id as string | undefined) ?? null;
  }

  list(repositoryId: string): IncidentRecord[] {
    return this.all('SELECT id FROM incident WHERE repository = ? ORDER BY created_at_utc, id', repositoryId).map((r) => this.get(r.id as string)!);
  }

  get(id: string): IncidentRecord | null {
    const h = this.one('SELECT * FROM incident WHERE id = ?', id);
    if (!h) return null;
    const rec: IncidentRecord = {
      id, taskRunId: (h.task_run_id as string | null) ?? null, repositoryId: h.repository as string, title: h.title as string, summary: h.summary as string,
      symptoms: [], expectedBehavior: [], actualBehavior: [], reproductionSteps: [], environment: {}, rootCauseHypotheses: [], attemptedFixes: [], regressionTests: [],
      affectedFiles: [], relatedCommits: [], relatedPullRequests: [], status: 'OPEN', createdAt: h.created_at_utc as string, updatedAt: h.created_at_utc as string,
    };
    if (h.github_issue_number != null) rec.githubIssueNumber = Number(h.github_issue_number);
    if (h.github_issue_url) rec.githubIssueUrl = h.github_issue_url as string;
    if (h.base_revision) rec.baseRevision = h.base_revision as string;
    if (h.supersedes) rec.supersedes = h.supersedes as string;
    for (const e of this.all('SELECT * FROM incident_entry WHERE incident_id = ? ORDER BY seq', id)) {
      rec.updatedAt = e.ts_utc as string;
      fold(rec, e.kind as string, JSON.parse(e.data as string) as Record<string, unknown>, e.ts_utc as string);
    }
    return rec;
  }
}

function fold(rec: IncidentRecord, kind: string, d: Record<string, unknown>, ts: string): void {
  const text = String(d.text ?? '');
  switch (kind) {
    case 'symptom': rec.symptoms.push(text); break;
    case 'expected': rec.expectedBehavior.push(text); break;
    case 'actual': rec.actualBehavior.push(text); break;
    case 'repro': rec.reproductionSteps.push(text); break;
    case 'environment': rec.environment[String(d.key)] = String(d.value); break;
    case 'hypothesis': rec.rootCauseHypotheses.push({ id: String(d.id), description: String(d.description), status: 'UNVERIFIED', evidence: (d.evidence as EvidenceReference[]) ?? [] }); break;
    case 'hypothesis-status': {
      const h: RootCauseHypothesis | undefined = rec.rootCauseHypotheses.find((x) => x.id === d.id);
      if (h) {
        h.status = d.status as HypothesisStatus;
        h.evidence.push(...((d.evidence as EvidenceReference[]) ?? []));
        if (h.status === 'CONFIRMED') rec.confirmedRootCause = h.description;
      }
      break;
    }
    case 'root-cause': rec.confirmedRootCause = String(d.description); break;
    case 'attempt': foldAttempt(rec, d, ts); break;
    case 'regression-test': foldTest(rec, d as unknown as RegressionTestReference); break;
    case 'commit': rec.relatedCommits.push(String(d.value)); break;
    case 'pull-request': rec.relatedPullRequests.push(String(d.value)); break;
    case 'affected-file': rec.affectedFiles.push(String(d.value)); break;
    case 'status': rec.status = d.status as IncidentStatus; break;
  }
}

/** A later outcome for the same attempt id updates what is shown, but both entries stay in the table. */
function foldAttempt(rec: IncidentRecord, d: Record<string, unknown>, ts: string): void {
  const a: IncidentAttempt = { id: String(d.id), description: String(d.description), outcome: d.outcome as AttemptOutcome, evidence: (d.evidence as EvidenceReference[]) ?? [], createdAt: ts };
  for (const k of ['commitSha', 'failureReason', 'diagnosis'] as const) if (typeof d[k] === 'string') a[k] = d[k];
  rec.attemptedFixes.push(a);
}

function foldTest(rec: IncidentRecord, t: RegressionTestReference): void {
  const i = rec.regressionTests.findIndex((x) => x.name === t.name);
  if (i >= 0) rec.regressionTests[i] = { ...rec.regressionTests[i], ...t };
  else rec.regressionTests.push(t);
}
