import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { buildGatePlan } from '../gates/plan';
import { gateReport, runGates } from '../gates/runner';
import { hashObject } from '../shared/hash';
import { PlError } from '../shared/errors';
import { ENGINE_VERSION } from '../version';
import { TERMINAL_STATES, type TaskState } from '../state/machine';
import type { TaskRun } from '../state/store';
import { type EngineDeps, clockOf, gateCtx, totalCostUsd } from './deps';
import { renderReport } from './report';
import { publishRoadmap } from '../blueprint/publish';
import { recordAnswer } from '../blueprint/interview';
import { getBlueprint } from '../blueprint/workflow';
import { runTasks } from './scheduler';
import { stepDeliver, stepPullRequest } from './steps-deliver';
import { block, excludeStateDir, stepPlan, stepReady, stepRecon } from './steps-plan';
import { stepRepair, stepReview, stepVerify } from './steps-verify';

export type Waiting = 'approval' | 'merge' | 'github' | 'human';
export interface DriveOutcome {
  runId: string;
  state: TaskState;
  waiting?: Waiting;
  reason?: string;
}

const MAX_STEPS = 500;

const NEXT_ACTION: Partial<Record<TaskState, string>> = {
  AWAITING_APPROVAL: 'review the plan, then `proofloop approve <id> --plan-hash <hash>` (or `reject`)',
  BLOCKED: 'resolve the blocker, then `proofloop resume <id> --retry`',
  PAUSED: '`proofloop resume <id>`',
  PR_OPEN: 'review and merge the pull request; `proofloop resume <id>` records completion',
  COMPLETE: 'done',
  CANCELLED: 'cancelled',
};

export class Engine {
  constructor(readonly d: EngineDeps) {}

  async start(input: { protocolId: string; intent: string; again?: boolean }): Promise<TaskRun> {
    const { d } = this;
    excludeStateDir(d.root);
    const protocol = d.registry.get(input.protocolId);
    const projectId = d.store.ensureProject({ name: basename(d.root), repository: await d.git.remoteRepo(d.root), defaultBranch: await d.git.defaultBranch(d.root), detectedStack: d.detected });
    const key = hashObject([input.protocolId, input.intent, d.root, input.again ? clockOf(d).nowMs() : 0]);
    let run = d.store.createRun({ projectId, protocolId: protocol.id, protocolVersion: protocol.version, intent: input.intent, risk: protocol.defaultRisk, repairBudget: protocol.retry.maxRepairAttempts, idempotencyKey: key });
    if (run.state === 'NEW') {
      d.store.audit(run.id, 'protocol.pinned', 'engine', { id: protocol.id, version: protocol.version, sha256: hashObject(protocol), engine: ENGINE_VERSION });
      run = d.store.transition(run.id, 'DISCOVERING', { actor: 'engine' });
    }
    if (protocol.mode === 'idea-to-product') recordAnswer(d.store, run.id, 'outcome', { text: input.intent, source: 'user' });
    await d.github.ensureParent(run.id, `[${protocol.id}] ${input.intent}`.slice(0, 120), `**Intent**\n\n${input.intent}\n\nProtocol: ${protocol.id}@${protocol.version}\nRun: \`${run.id}\``, [protocol.id === 'bug' ? 'bug' : 'feature']);
    return d.store.getRun(run.id);
  }

  private guards(runId: string): DriveOutcome | null {
    const { d } = this;
    const run = d.store.getRun(runId);
    if (d.store.events(runId, 'cancel.requested').length > 0 && !TERMINAL_STATES.includes(run.state)) {
      d.store.transition(runId, 'CANCELLED', { actor: 'engine', reason: 'cancellation requested' });
      return { runId, state: 'CANCELLED' };
    }
    return null;
  }

  private async overBudget(runId: string): Promise<string | null> {
    const { d } = this;
    const run = d.store.getRun(runId);
    if (clockOf(d).nowMs() - Date.parse(run.createdAtUtc) > d.config.limits.wallClockMs) return 'wall-clock budget exhausted';
    return totalCostUsd(d, runId) >= d.config.limits.maxBudgetUsd ? `spend budget of $${d.config.limits.maxBudgetUsd} exhausted` : null;
  }

  /** Advances the run until it needs a human, is blocked, or finishes. Every step re-reads durable state, so it is resumable. */
  async drive(runId: string): Promise<DriveOutcome> {
    const { d } = this;
    for (let i = 0; i < MAX_STEPS; i++) {
      const stop = this.guards(runId);
      if (stop) return stop;
      d.store.heartbeat(runId);
      const run = d.store.getRun(runId);
      if (!['AWAITING_APPROVAL', 'BLOCKED', 'PAUSED', 'COMPLETE', 'CANCELLED', 'PR_OPEN'].includes(run.state)) {
        const over = await this.overBudget(runId);
        if (over) {
          await block(d, runId, over);
          continue;
        }
      }
      const out = await this.advance(run);
      if (out) return out;
    }
    throw new PlError('PL_ENGINE_001', `run ${runId} did not settle after ${MAX_STEPS} steps`);
  }

  private async advance(run: TaskRun): Promise<DriveOutcome | null> {
    const { d } = this;
    const id = run.id;
    const stop = (waiting?: Waiting, reason?: string): DriveOutcome => ({ runId: id, state: d.store.getRun(id).state, waiting, reason });
    switch (run.state) {
      case 'NEW':
        d.store.transition(id, 'DISCOVERING', { actor: 'engine' });
        return null;
      case 'DISCOVERING':
        if (this.isIdea(run)) return stop('human', 'interview in progress: `proofloop blueprint next-question`, then `blueprint submit`');
        stepRecon(d, id);
        return null;
      case 'PLANNING':
        if (this.isIdea(run)) return stop('human', 'waiting for a blueprint: `proofloop blueprint submit`');
        await stepPlan(d, id);
        return null;
      case 'AWAITING_APPROVAL':
        return stop('approval', 'plan awaits human approval');
      case 'APPROVED':
        d.store.transition(id, 'READY', { actor: 'engine' });
        return null;
      case 'READY':
        await stepReady(d, id);
        return null;
      case 'RUNNING':
        return this.running(id);
      case 'VERIFYING':
        await stepVerify(d, id);
        return null;
      case 'REPAIRING':
        await stepRepair(d, id);
        return null;
      case 'REVIEW_REQUIRED':
        return this.reviewAndDeliver(id);
      case 'PR_OPEN':
        return this.pullRequest(id);
      case 'BLOCKED':
      case 'PAUSED':
        return stop('human', run.blockedReason ?? 'paused');
      default:
        return stop();
    }
  }

  private isIdea(run: TaskRun): boolean {
    return this.d.registry.get(run.protocolId).mode === 'idea-to-product';
  }

  /** Publishes the approved roadmap (GitHub) in place of implementation tasks. */
  private async publish(id: string): Promise<DriveOutcome | null> {
    const { d } = this;
    if (!d.port) d.store.audit(id, 'roadmap.skipped', 'engine', { reason: 'GitHub disabled: roadmap lives in docs/product only' });
    else {
      try {
        await publishRoadmap(d.store, d.port, id, getBlueprint(d.store, id));
      } catch (e) {
        await block(d, id, `roadmap publishing failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }
    d.store.transition(id, 'VERIFYING', { actor: 'engine' });
    return null;
  }

  private async running(id: string): Promise<DriveOutcome | null> {
    const { d } = this;
    if (this.isIdea(d.store.getRun(id))) return this.publish(id);
    const out = await runTasks(d, id);
    if (out.result === 'done') {
      d.store.transition(id, 'VERIFYING', { actor: 'engine' });
      return null;
    }
    if (out.result === 'cancelled') return null;
    if (out.result === 'paused') {
      d.store.transition(id, 'PAUSED', { actor: 'engine', reason: out.reason });
      return { runId: id, state: 'PAUSED', waiting: 'human', reason: out.reason };
    }
    await block(d, id, out.reason);
    return null;
  }

  private async reviewAndDeliver(id: string): Promise<DriveOutcome | null> {
    const { d } = this;
    if ((await stepReview(d, id)) === 'handled') return null;
    const out = await stepDeliver(d, id);
    return out === 'delivered' ? null : { runId: id, state: d.store.getRun(id).state, waiting: 'github', reason: out.reason };
  }

  private async pullRequest(id: string): Promise<DriveOutcome | null> {
    const out = await stepPullRequest(this.d, id);
    if (typeof out === 'object') return { runId: id, state: this.d.store.getRun(id).state, waiting: 'merge', reason: out.reason };
    return out === 'complete' ? { runId: id, state: 'COMPLETE' } : null;
  }

  /** Reconciles durable state with Git, then continues. Never marks unfinished or unverified work complete. */
  async resume(runId: string, opts: { retry?: boolean } = {}): Promise<DriveOutcome> {
    const { d } = this;
    const interrupted = d.store.interruptRunningSteps(runId);
    const run0 = d.store.getRun(runId);
    d.store.audit(runId, 'resume', 'engine', { state: run0.state, interruptedSteps: interrupted });
    await d.github.flush(runId);
    if (TERMINAL_STATES.includes(run0.state)) return { runId, state: run0.state };
    if (run0.state === 'BLOCKED' && !opts.retry) return { runId, state: 'BLOCKED', waiting: 'human', reason: run0.blockedReason ?? 'blocked' };
    if (!(await this.reconcileGit(runId))) return { runId, state: 'BLOCKED', waiting: 'human', reason: d.store.getRun(runId).blockedReason ?? 'worktree missing' };
    const run = d.store.getRun(runId);
    if (run.state === 'BLOCKED' || run.state === 'PAUSED') {
      d.store.audit(runId, 'resumed', 'engine');
      d.store.transition(runId, this.recoveryTarget(run), { actor: 'engine', reason: `resume from ${run.state}` });
    }
    return this.drive(runId);
  }

  private recoveryTarget(run: TaskRun): TaskState {
    if (run.approvedPlanHash && run.approvedPlanHash === run.currentPlanHash) return 'READY';
    return run.currentPlanHash ? 'PLANNING' : 'DISCOVERING';
  }

  /** Returns false when the worktree vanished: the run is blocked (branch commits are kept) and `--retry` recreates it. */
  private async reconcileGit(runId: string): Promise<boolean> {
    const { d } = this;
    const run = d.store.getRun(runId);
    if (!run.worktreePath) return true;
    if (!existsSync(run.worktreePath)) {
      d.store.audit(runId, 'resume.worktree-missing', 'engine', { path: run.worktreePath });
      d.store.setFields(runId, { worktreePath: '' });
      if (run.state !== 'BLOCKED') await block(d, runId, `worktree ${run.worktreePath} is missing; its branch is intact. Resume with --retry to recreate it`);
      return false;
    }
    const head = await d.git.head(run.worktreePath);
    const dirty = !(await d.git.isClean(run.worktreePath));
    if (head !== run.headSha) d.store.setFields(runId, { headSha: head });
    d.store.audit(runId, 'resume.reconciled', 'engine', { recordedHead: run.headSha, actualHead: head, dirty });
    return true;
  }

  /**
   * `proofloop verify`: run the detected gates against the current clean commit and record evidence.
   * It creates a ledger entry but never advances the delivery state machine.
   */
  async verifyCurrent(cwd = this.d.root): Promise<{ runId: string; report: string; allRequiredPass: boolean }> {
    const { d } = this;
    excludeStateDir(d.root);
    const protocol = d.registry.get('verify');
    const head = await d.git.head(cwd);
    if (!(await d.git.isClean(cwd))) throw new PlError('PL_VERIFY_001', 'working tree has uncommitted changes; commit first so evidence maps to a commit');
    const projectId = d.store.ensureProject({ name: basename(d.root), repository: await d.git.remoteRepo(d.root), defaultBranch: await d.git.defaultBranch(d.root), detectedStack: d.detected });
    const run = d.store.createRun({ projectId, protocolId: protocol.id, protocolVersion: protocol.version, intent: `verify ${head.slice(0, 12)}`, risk: 'low', repairBudget: 0 });
    d.store.setFields(run.id, { headSha: head, baseCommit: head, worktreePath: cwd });
    const entries = buildGatePlan(protocol, 'low', d.detected, d.config);
    d.store.setGatePlan(run.id, entries.map((e) => ({ gateId: e.gateId, kind: e.kind, required: e.required, command: e.command })));
    await runGates(gateCtx(d, run.id, cwd, head), entries);
    const rep = gateReport(d.store, run.id);
    return { runId: run.id, report: renderReport(d.store, run.id), allRequiredPass: rep.allRequiredPass };
  }

  /** Stops new work. If a worker holds a live lease the drive loop honours the request; otherwise cancel is immediate. */
  async cancel(runId: string, reason = 'user'): Promise<DriveOutcome> {
    const { d } = this;
    d.store.audit(runId, 'cancel.requested', 'engine', { reason });
    const run = d.store.getRun(runId);
    const now = clockOf(d).nowMs();
    const live = d.store.nodes(runId).some((n) => {
      const l = d.store.getLease(runId, n.id);
      return l?.state === 'ACTIVE' && Date.parse(l.leaseExpiresAtUtc) > now;
    });
    if (!live && !TERMINAL_STATES.includes(run.state)) d.store.transition(runId, 'CANCELLED', { actor: 'engine', reason });
    return { runId, state: d.store.getRun(runId).state };
  }

  pause(runId: string): void {
    this.d.store.audit(runId, 'pause.requested', 'engine');
  }

  status(runId: string): { run: TaskRun; next: string; gates: ReturnType<typeof gateReport> | null; nodes: ReturnType<EngineDeps['store']['nodes']>; pendingSync: number; failingGate: string | null; retries: string } {
    const { d } = this;
    const run = d.store.getRun(runId);
    const gates = d.store.getGatePlan(runId).length ? gateReport(d.store, runId) : null;
    const failing = gates?.gates.find((g) => g.required && g.state !== 'PASS')?.gateId ?? null;
    return { run, next: NEXT_ACTION[run.state] ?? 'running', gates, nodes: d.store.nodes(runId), pendingSync: d.store.pendingOutbox(runId).length, failingGate: failing, retries: `${run.repairCount}/${run.repairBudget}` };
  }

  report(runId: string): string {
    return renderReport(this.d.store, runId);
  }

  worktreeOf(runId: string): string | null {
    const p = this.d.store.getRun(runId).worktreePath;
    return p ? join(p) : null;
  }
}
