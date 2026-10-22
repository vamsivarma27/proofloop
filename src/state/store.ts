import { type Clock, newId, systemClock } from '../shared/clock';
import { PlError } from '../shared/errors';
import { redactValue } from '../shared/redact';
import { ENGINE_VERSION } from '../version';
import { type RiskLevel, riskRank } from '../protocol/schema';
import { type Db, inTransaction } from './db';
import { type GateSnapshot, type GateState, type GuardContext, type TaskState, checkGuards, isAllowedTransition } from './machine';

export interface TaskRun {
  id: string;
  projectId: string;
  protocolId: string;
  protocolVersion: string;
  engineVersion: string;
  state: TaskState;
  intent: string;
  risk: RiskLevel;
  sourceIssueId: string | null;
  sourceIssueNumber: number | null;
  planVersion: number;
  currentPlanHash: string | null;
  approvedPlanHash: string | null;
  baseCommit: string | null;
  headSha: string | null;
  activeBranch: string | null;
  worktreePath: string | null;
  repairCount: number;
  repairBudget: number;
  prUrl: string | null;
  blockedReason: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}

type Row = Record<string, unknown>;

const toRun = (r: Row): TaskRun => ({
  id: r.id as string,
  projectId: r.project_id as string,
  protocolId: r.protocol_id as string,
  protocolVersion: r.protocol_version as string,
  engineVersion: r.engine_version as string,
  state: r.state as TaskState,
  intent: r.intent as string,
  risk: r.risk as RiskLevel,
  sourceIssueId: (r.source_issue_id as string | null) ?? null,
  sourceIssueNumber: (r.source_issue_number as number | null) ?? null,
  planVersion: r.plan_version as number,
  currentPlanHash: (r.current_plan_hash as string | null) ?? null,
  approvedPlanHash: (r.approved_plan_hash as string | null) ?? null,
  baseCommit: (r.base_commit as string | null) ?? null,
  headSha: (r.head_sha as string | null) ?? null,
  activeBranch: (r.active_branch as string | null) ?? null,
  worktreePath: (r.worktree_path as string | null) ?? null,
  repairCount: r.repair_count as number,
  repairBudget: r.repair_budget as number,
  prUrl: (r.pr_url as string | null) ?? null,
  blockedReason: (r.blocked_reason as string | null) ?? null,
  createdAtUtc: r.created_at_utc as string,
  updatedAtUtc: r.updated_at_utc as string,
});

export interface GateResultInput {
  taskRunId: string;
  gateId: string;
  state: GateState;
  required: boolean;
  commandOrAssertion: string;
  exitCode: number | null;
  evidenceIds: string[];
  commitSha: string;
  startedAtUtc: string;
  finishedAtUtc: string;
  failureCategory?: string | undefined;
  fingerprint?: string | undefined;
}

export interface GateResultRow extends GateResultInput {
  id: string;
  seq: number;
}

export interface EvidenceInput {
  taskRunId: string;
  gateId?: string | undefined;
  kind: string;
  uri: string;
  checksum: string;
  commitSha?: string | undefined;
  environment: string;
  summary: string;
  redactionStatus: 'redacted' | 'none-needed';
}

export interface Lease {
  taskNodeId: string;
  taskRunId: string;
  workerId: string;
  generation: number;
  leaseExpiresAtUtc: string;
  worktreePath: string | null;
  branch: string | null;
  state: string;
}

export class Store {
  constructor(
    readonly db: Db,
    readonly clock: Clock = systemClock,
  ) {}

  private all(sql: string, ...p: Array<string | number | null>): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  private one(sql: string, ...p: Array<string | number | null>): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }
  private run(sql: string, ...p: Array<string | number | null>): void {
    this.db.prepare(sql).run(...p);
  }

  // ---- audit & idempotency -------------------------------------------------
  audit(taskRunId: string | null, kind: string, actor: string, data: Record<string, unknown> = {}): void {
    this.run('INSERT INTO event (task_run_id, ts_utc, kind, actor, data) VALUES (?,?,?,?,?)', taskRunId, this.clock.nowIso(), kind, actor, JSON.stringify(redactValue(data)));
  }

  events(taskRunId: string, kind?: string): Array<{ kind: string; actor: string; ts: string; data: Record<string, unknown> }> {
    const rows = kind
      ? this.all('SELECT * FROM event WHERE task_run_id = ? AND kind = ? ORDER BY id', taskRunId, kind)
      : this.all('SELECT * FROM event WHERE task_run_id = ? ORDER BY id', taskRunId);
    return rows.map((r) => ({ kind: r.kind as string, actor: r.actor as string, ts: r.ts_utc as string, data: JSON.parse(r.data as string) }));
  }

  getKey(key: string): string | undefined {
    return this.one('SELECT value FROM idempotency WHERE key = ?', key)?.value as string | undefined;
  }

  /** Upsert, for mutable engine bookkeeping (putKey is write-once). */
  setKey(key: string, value: string): void {
    this.run('INSERT INTO idempotency (key, value, created_at_utc) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value, this.clock.nowIso());
  }

  putKey(key: string, value: string): void {
    this.run('INSERT OR IGNORE INTO idempotency (key, value, created_at_utc) VALUES (?,?,?)', key, value, this.clock.nowIso());
  }

  // ---- project & runs ------------------------------------------------------
  ensureProject(p: { name: string; repository: string | null; defaultBranch: string | null; detectedStack?: unknown }): string {
    const existing = this.one('SELECT id FROM project WHERE name = ? AND COALESCE(repository,\'\') = ?', p.name, p.repository ?? '');
    if (existing) return existing.id as string;
    const id = newId('prj');
    this.run('INSERT INTO project (id, name, repository, default_branch, created_at_utc, detected_stack) VALUES (?,?,?,?,?,?)', id, p.name, p.repository, p.defaultBranch, this.clock.nowIso(), JSON.stringify(p.detectedStack ?? {}));
    return id;
  }

  createRun(input: { projectId: string; protocolId: string; protocolVersion: string; intent: string; risk: RiskLevel; repairBudget: number; idempotencyKey?: string }): TaskRun {
    return inTransaction(this.db, () => {
      if (input.idempotencyKey) {
        const prior = this.getKey(`run:${input.idempotencyKey}`);
        if (prior) return this.getRun(prior);
      }
      const id = newId('run');
      const now = this.clock.nowIso();
      this.run(
        `INSERT INTO task_run (id, project_id, protocol_id, protocol_version, engine_version, state, intent, risk, repair_budget, created_at_utc, updated_at_utc)
         VALUES (?,?,?,?,?,'NEW',?,?,?,?,?)`,
        id, input.projectId, input.protocolId, input.protocolVersion, ENGINE_VERSION, input.intent, input.risk, input.repairBudget, now, now,
      );
      if (input.idempotencyKey) this.putKey(`run:${input.idempotencyKey}`, id);
      this.audit(id, 'run.created', 'engine', { protocol: input.protocolId, risk: input.risk });
      return this.getRun(id);
    });
  }

  getRun(id: string): TaskRun {
    const r = this.one('SELECT * FROM task_run WHERE id = ?', id);
    if (!r) throw new PlError('PL_STATE_404', `no such task run "${id}"`);
    return toRun(r);
  }

  listRuns(opts: { activeOnly?: boolean } = {}): TaskRun[] {
    const rows = this.all('SELECT * FROM task_run ORDER BY created_at_utc, id');
    const runs = rows.map(toRun);
    return opts.activeOnly ? runs.filter((r) => r.state !== 'COMPLETE' && r.state !== 'CANCELLED') : runs;
  }

  private patch(id: string, fields: Record<string, string | number | null>): void {
    const keys = Object.keys(fields);
    const set = keys.map((k) => `${k} = ?`).join(', ');
    this.run(`UPDATE task_run SET ${set}, updated_at_utc = ? WHERE id = ?`, ...keys.map((k) => fields[k] as string | number | null), this.clock.nowIso(), id);
  }

  setFields(id: string, f: Partial<{ headSha: string; baseCommit: string; activeBranch: string; worktreePath: string; prUrl: string; sourceIssueId: string; sourceIssueNumber: number; risk: RiskLevel }>): void {
    const map: Record<string, string> = { headSha: 'head_sha', baseCommit: 'base_commit', activeBranch: 'active_branch', worktreePath: 'worktree_path', prUrl: 'pr_url', sourceIssueId: 'source_issue_id', sourceIssueNumber: 'source_issue_number' };
    const fields: Record<string, string | number | null> = {};
    for (const [k, v] of Object.entries(f)) fields[map[k]!] = v as string | number;
    this.patch(id, fields);
  }

  /** Risk is monotonic: it can be raised, never lowered, by anything in the engine. */
  raiseRisk(id: string, risk: RiskLevel): TaskRun {
    const run = this.getRun(id);
    if (riskRank(risk) > riskRank(run.risk)) {
      this.patch(id, { risk });
      this.audit(id, 'risk.raised', 'engine', { from: run.risk, to: risk });
    }
    return this.getRun(id);
  }

  heartbeat(id: string): void {
    this.patch(id, { last_heartbeat_utc: this.clock.nowIso() });
  }

  guardContext(id: string): GuardContext {
    const r = this.getRun(id);
    return {
      currentPlanHash: r.currentPlanHash,
      approvedPlanHash: r.approvedPlanHash,
      headSha: r.headSha,
      requiredGates: this.requiredGateSnapshots(id),
      repairCount: r.repairCount,
      repairBudget: r.repairBudget,
      prUrl: r.prUrl,
    };
  }

  /** The only way a task changes state: preconditions are checked and the write is durable before returning. */
  transition(id: string, to: TaskState, by: { actor: string; reason?: string }): TaskRun {
    const outcome = inTransaction(this.db, (): TaskRun | PlError => {
      const run = this.getRun(id);
      const refusal = this.refusal(run, to);
      if (refusal) {
        // committed before throwing so the denial survives in the audit trail
        this.audit(id, 'transition.denied', by.actor, { from: run.state, to, why: refusal.message });
        return refusal;
      }
      const extra: Record<string, string | number | null> = { state: to, blocked_reason: to === 'BLOCKED' ? (by.reason ?? 'unspecified') : null };
      if (to === 'REPAIRING') extra.repair_count = run.repairCount + 1;
      this.patch(id, extra);
      this.audit(id, 'transition', by.actor, { from: run.state, to, reason: by.reason ?? null });
      return this.getRun(id);
    });
    if (outcome instanceof PlError) throw outcome;
    return outcome;
  }

  private refusal(run: TaskRun, to: TaskState): PlError | null {
    if (!isAllowedTransition(run.state, to)) return new PlError('PL_STATE_001', `invalid transition ${run.state} -> ${to}`);
    const guard = checkGuards(run.state, to, this.guardContext(run.id));
    return guard.ok ? null : new PlError(guard.code, `${run.state} -> ${to} refused: ${guard.reason}`);
  }

  // ---- plans & approvals ---------------------------------------------------
  recordPlan(id: string, body: unknown, hash: string): TaskRun {
    return inTransaction(this.db, () => {
      const run = this.getRun(id);
      if (run.state !== 'PLANNING' && run.state !== 'AWAITING_APPROVAL')
        throw new PlError('PL_PLAN_001', `plans can only change while PLANNING or AWAITING_APPROVAL (state ${run.state})`);
      if (run.currentPlanHash === hash) return run;
      const version = run.planVersion + 1;
      this.run('INSERT INTO plan (task_run_id, version, hash, body, created_at_utc) VALUES (?,?,?,?,?)', id, version, hash, JSON.stringify(body), this.clock.nowIso());
      this.patch(id, { plan_version: version, current_plan_hash: hash });
      this.audit(id, 'plan.recorded', 'engine', { version, hash });
      return this.getRun(id);
    });
  }

  getPlanBody(id: string, version?: number): unknown {
    const run = this.getRun(id);
    const row = this.one('SELECT body FROM plan WHERE task_run_id = ? AND version = ?', id, version ?? run.planVersion);
    return row ? JSON.parse(row.body as string) : undefined;
  }

  recordApproval(id: string, a: { scope: string; planHash: string | null; approvedBy: string; decision: 'approve' | 'reject'; comment?: string }): void {
    if (!a.approvedBy.startsWith('human:')) {
      this.audit(id, 'approval.refused', a.approvedBy, { scope: a.scope, why: 'approver is not a human' });
      throw new PlError('PL_APPROVAL_001', 'approvals can only be recorded by a human actor (human:<name>), never by an agent');
    }
    inTransaction(this.db, () => {
      const run = this.getRun(id);
      if (a.scope === 'plan') {
        if (run.state !== 'AWAITING_APPROVAL') throw new PlError('PL_PLAN_002', `no plan is awaiting approval (state ${run.state})`);
        if (a.planHash !== run.currentPlanHash) throw new PlError('PL_PLAN_003', 'approval references a stale plan hash; review the current plan');
        if (a.decision === 'approve') this.patch(id, { approved_plan_hash: a.planHash });
      }
      this.run('INSERT INTO approval (id, task_run_id, scope, plan_hash, approved_by, decision, comment, created_at_utc) VALUES (?,?,?,?,?,?,?,?)', newId('apr'), id, a.scope, a.planHash, a.approvedBy, a.decision, a.comment ?? null, this.clock.nowIso());
      this.audit(id, `approval.${a.decision}`, a.approvedBy, { scope: a.scope, planHash: a.planHash });
    });
  }

  hasGatedApproval(id: string, scope: string): boolean {
    return Boolean(this.one("SELECT 1 AS x FROM approval WHERE task_run_id = ? AND scope = ? AND decision = 'approve'", id, scope));
  }

  approvals(id: string): Row[] {
    return this.all('SELECT * FROM approval WHERE task_run_id = ? ORDER BY created_at_utc, id', id);
  }

  // ---- gates & evidence ----------------------------------------------------
  setGatePlan(id: string, gates: Array<{ gateId: string; kind: string; required: boolean; command: string | null }>): void {
    inTransaction(this.db, () => {
      this.run('DELETE FROM gate_plan WHERE task_run_id = ?', id);
      for (const g of gates) this.run('INSERT INTO gate_plan (task_run_id, gate_id, kind, required, command) VALUES (?,?,?,?,?)', id, g.gateId, g.kind, g.required ? 1 : 0, g.command);
    });
  }

  getGatePlan(id: string): Array<{ gateId: string; kind: string; required: boolean; command: string | null }> {
    return this.all('SELECT * FROM gate_plan WHERE task_run_id = ? ORDER BY gate_id', id).map((r) => ({
      gateId: r.gate_id as string,
      kind: r.kind as string,
      required: r.required === 1,
      command: (r.command as string | null) ?? null,
    }));
  }

  addEvidence(e: EvidenceInput): string {
    const id = newId('evd');
    this.run(
      `INSERT INTO evidence_artifact (id, task_run_id, gate_id, kind, uri, checksum, commit_sha, environment, created_at_utc, summary, redaction_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, e.taskRunId, e.gateId ?? null, e.kind, e.uri, e.checksum, e.commitSha ?? null, e.environment, this.clock.nowIso(), e.summary, e.redactionStatus,
    );
    return id;
  }

  evidenceFor(id: string): Row[] {
    return this.all('SELECT * FROM evidence_artifact WHERE task_run_id = ? ORDER BY created_at_utc, id', id);
  }

  recordGateResult(g: GateResultInput): string {
    return inTransaction(this.db, () => {
      const seq = Number((this.one('SELECT COALESCE(MAX(seq),0) AS m FROM gate_result WHERE task_run_id = ?', g.taskRunId) as Row).m) + 1;
      const id = newId('gate');
      this.run(
        `INSERT INTO gate_result (id, task_run_id, gate_id, state, required, command_or_assertion, exit_code, evidence_ids, commit_sha, started_at_utc, finished_at_utc, failure_category, fingerprint, seq)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, g.taskRunId, g.gateId, g.state, g.required ? 1 : 0, g.commandOrAssertion, g.exitCode, JSON.stringify(g.evidenceIds), g.commitSha, g.startedAtUtc, g.finishedAtUtc, g.failureCategory ?? null, g.fingerprint ?? null, seq,
      );
      return id;
    });
  }

  gateHistory(id: string, gateId?: string): GateResultRow[] {
    const rows = gateId
      ? this.all('SELECT * FROM gate_result WHERE task_run_id = ? AND gate_id = ? ORDER BY seq', id, gateId)
      : this.all('SELECT * FROM gate_result WHERE task_run_id = ? ORDER BY seq', id);
    return rows.map((r) => ({
      id: r.id as string,
      seq: r.seq as number,
      taskRunId: r.task_run_id as string,
      gateId: r.gate_id as string,
      state: r.state as GateState,
      required: r.required === 1,
      commandOrAssertion: r.command_or_assertion as string,
      exitCode: (r.exit_code as number | null) ?? null,
      evidenceIds: JSON.parse(r.evidence_ids as string) as string[],
      commitSha: r.commit_sha as string,
      startedAtUtc: r.started_at_utc as string,
      finishedAtUtc: r.finished_at_utc as string,
      failureCategory: (r.failure_category as string | null) ?? undefined,
      fingerprint: (r.fingerprint as string | null) ?? undefined,
    }));
  }

  requiredGateSnapshots(id: string): GateSnapshot[] {
    return this.getGatePlan(id)
      .filter((g) => g.required)
      .map((g) => {
        const last = this.gateHistory(id, g.gateId).at(-1);
        return { gateId: g.gateId, state: last?.state ?? 'MISSING', commitSha: last?.commitSha ?? null } satisfies GateSnapshot;
      });
  }

  // ---- steps (resumable, idempotent) --------------------------------------
  stepDone(taskRunId: string, stepId: string): boolean {
    return Boolean(this.one("SELECT 1 AS x FROM step_run WHERE task_run_id = ? AND step_id = ? AND state = 'DONE'", taskRunId, stepId));
  }

  beginStep(taskRunId: string, stepId: string, inputRef?: string): { id: string; attempt: number } {
    return inTransaction(this.db, () => {
      const attempt = Number((this.one('SELECT COALESCE(MAX(attempt),0) AS a FROM step_run WHERE task_run_id = ? AND step_id = ?', taskRunId, stepId) as Row).a) + 1;
      const id = newId('stp');
      this.run('INSERT INTO step_run (id, task_run_id, step_id, state, attempt, started_at_utc, input_ref) VALUES (?,?,?,?,?,?,?)', id, taskRunId, stepId, 'RUNNING', attempt, this.clock.nowIso(), inputRef ?? null);
      return { id, attempt };
    });
  }

  finishStep(stepRunId: string, r: { state: 'DONE' | 'FAILED' | 'INTERRUPTED'; outputRef?: string; exitCode?: number | null; errorCategory?: string }): void {
    this.run('UPDATE step_run SET state = ?, finished_at_utc = ?, output_ref = ?, exit_code = ?, error_category = ? WHERE id = ?', r.state, this.clock.nowIso(), r.outputRef ?? null, r.exitCode ?? null, r.errorCategory ?? null, stepRunId);
  }

  steps(taskRunId: string): Row[] {
    return this.all('SELECT * FROM step_run WHERE task_run_id = ? ORDER BY started_at_utc, attempt', taskRunId);
  }

  /** Steps left RUNNING by a dead process; resume marks them INTERRUPTED and redoes (never skips) them. */
  interruptRunningSteps(taskRunId: string): number {
    const rows = this.all("SELECT id FROM step_run WHERE task_run_id = ? AND state = 'RUNNING'", taskRunId);
    for (const r of rows) this.finishStep(r.id as string, { state: 'INTERRUPTED' });
    return rows.length;
  }

  // ---- task nodes & leases -------------------------------------------------
  saveTaskNodes(taskRunId: string, nodes: Array<{ id: string; title: string; description: string; dependencies: string[]; fileScopes: string[]; acceptanceCriteria: string[]; riskLevel: RiskLevel }>): void {
    inTransaction(this.db, () => {
      this.run('DELETE FROM task_node WHERE task_run_id = ?', taskRunId);
      for (const n of nodes)
        this.run('INSERT INTO task_node (id, task_run_id, title, description, dependencies, file_scopes, acceptance_criteria, risk_level) VALUES (?,?,?,?,?,?,?,?)', n.id, taskRunId, n.title, n.description, JSON.stringify(n.dependencies), JSON.stringify(n.fileScopes), JSON.stringify(n.acceptanceCriteria), n.riskLevel);
    });
  }

  nodes(taskRunId: string): Array<{ id: string; title: string; dependencies: string[]; fileScopes: string[]; state: string; riskLevel: RiskLevel; failureFingerprint: string | null }> {
    return this.all('SELECT * FROM task_node WHERE task_run_id = ? ORDER BY id', taskRunId).map((r) => ({
      id: r.id as string,
      title: r.title as string,
      dependencies: JSON.parse(r.dependencies as string) as string[],
      fileScopes: JSON.parse(r.file_scopes as string) as string[],
      state: r.state as string,
      riskLevel: r.risk_level as RiskLevel,
      failureFingerprint: (r.failure_fingerprint as string | null) ?? null,
    }));
  }

  setNodeState(taskRunId: string, nodeId: string, state: string, fingerprint?: string): void {
    this.run('UPDATE task_node SET state = ?, failure_fingerprint = COALESCE(?, failure_fingerprint) WHERE task_run_id = ? AND id = ?', state, fingerprint ?? null, taskRunId, nodeId);
  }

  /** Grants the lease only if free or expired; the generation fences out stale holders. */
  acquireLease(taskRunId: string, nodeId: string, workerId: string, ttlMs: number, loc: { worktreePath?: string; branch?: string } = {}): Lease | null {
    return inTransaction(this.db, () => {
      const now = this.clock.nowMs();
      const cur = this.one('SELECT * FROM worker_lease WHERE task_run_id = ? AND task_node_id = ?', taskRunId, nodeId);
      const expiresIso = new Date(now + ttlMs).toISOString();
      if (cur && Date.parse(cur.lease_expires_at_utc as string) > now && cur.state === 'ACTIVE') return null;
      const generation = cur ? (cur.generation as number) + 1 : 1;
      this.run(
        `INSERT INTO worker_lease (task_node_id, task_run_id, worker_id, lease_expires_at_utc, heartbeat_at_utc, worktree_path, branch, state, generation)
         VALUES (?,?,?,?,?,?,?,'ACTIVE',?)
         ON CONFLICT (task_run_id, task_node_id) DO UPDATE SET worker_id = excluded.worker_id, lease_expires_at_utc = excluded.lease_expires_at_utc,
           heartbeat_at_utc = excluded.heartbeat_at_utc, worktree_path = excluded.worktree_path, branch = excluded.branch, state = 'ACTIVE', generation = excluded.generation`,
        nodeId, taskRunId, workerId, expiresIso, this.clock.nowIso(), loc.worktreePath ?? null, loc.branch ?? null, generation,
      );
      this.audit(taskRunId, 'lease.acquired', workerId, { nodeId, generation });
      return this.getLease(taskRunId, nodeId);
    });
  }

  getLease(taskRunId: string, nodeId: string): Lease | null {
    const r = this.one('SELECT * FROM worker_lease WHERE task_run_id = ? AND task_node_id = ?', taskRunId, nodeId);
    return r
      ? { taskNodeId: nodeId, taskRunId, workerId: r.worker_id as string, generation: r.generation as number, leaseExpiresAtUtc: r.lease_expires_at_utc as string, worktreePath: (r.worktree_path as string | null) ?? null, branch: (r.branch as string | null) ?? null, state: r.state as string }
      : null;
  }

  /** Returns false when the caller's lease was taken over (stale generation) or expired. */
  heartbeatLease(taskRunId: string, nodeId: string, workerId: string, generation: number, ttlMs: number): boolean {
    return inTransaction(this.db, () => {
      const cur = this.getLease(taskRunId, nodeId);
      if (!cur || cur.workerId !== workerId || cur.generation !== generation || cur.state !== 'ACTIVE') return false;
      if (Date.parse(cur.leaseExpiresAtUtc) <= this.clock.nowMs()) return false;
      this.run('UPDATE worker_lease SET lease_expires_at_utc = ?, heartbeat_at_utc = ? WHERE task_run_id = ? AND task_node_id = ?', new Date(this.clock.nowMs() + ttlMs).toISOString(), this.clock.nowIso(), taskRunId, nodeId);
      return true;
    });
  }

  releaseLease(taskRunId: string, nodeId: string, workerId: string, generation: number): void {
    this.run("UPDATE worker_lease SET state = 'RELEASED' WHERE task_run_id = ? AND task_node_id = ? AND worker_id = ? AND generation = ?", taskRunId, nodeId, workerId, generation);
  }

  /** Only for a holder known to be dead (pid gone). Increments nothing; the next acquire bumps the generation. */
  releaseAnyLease(taskRunId: string, nodeId: string): void {
    this.run("UPDATE worker_lease SET state = 'RELEASED' WHERE task_run_id = ? AND task_node_id = ?", taskRunId, nodeId);
  }

  expiredLeases(taskRunId: string): Lease[] {
    return this.all("SELECT task_node_id FROM worker_lease WHERE task_run_id = ? AND state = 'ACTIVE'", taskRunId)
      .map((r) => this.getLease(taskRunId, r.task_node_id as string)!)
      .filter((l) => Date.parse(l.leaseExpiresAtUtc) <= this.clock.nowMs());
  }

  // ---- outbox (GitHub unavailable => queue, never pretend) -----------------
  enqueue(taskRunId: string | null, kind: string, key: string, payload: unknown): void {
    this.run('INSERT OR IGNORE INTO sync_outbox (task_run_id, kind, key, payload, created_at_utc) VALUES (?,?,?,?,?)', taskRunId, kind, key, JSON.stringify(redactValue(payload)), this.clock.nowIso());
  }

  pendingOutbox(taskRunId?: string): Array<{ id: number; kind: string; key: string; payload: unknown; attempts: number }> {
    const rows = taskRunId ? this.all("SELECT * FROM sync_outbox WHERE status = 'PENDING' AND task_run_id = ? ORDER BY id", taskRunId) : this.all("SELECT * FROM sync_outbox WHERE status = 'PENDING' ORDER BY id");
    return rows.map((r) => ({ id: r.id as number, kind: r.kind as string, key: r.key as string, payload: JSON.parse(r.payload as string), attempts: r.attempts as number }));
  }

  markOutbox(id: number, status: 'DONE' | 'PENDING'): void {
    this.run('UPDATE sync_outbox SET status = ?, attempts = attempts + 1 WHERE id = ?', status, id);
  }
}
