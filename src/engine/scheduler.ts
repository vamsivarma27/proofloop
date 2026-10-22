import { join } from 'node:path';
import { isPidAlive } from '../shared/proc';
import { type Plan } from '../plan/schema';
import { readyNodes } from '../plan/dag';
import { getPlan } from '../plan/workflow';
import { scopesOverlap } from '../policy/paths';
import { PlError } from '../shared/errors';
import type { TaskRun } from '../state/store';
import { recordReproduction } from './bug';
import { type EngineDeps, callAgent, commitType, implementerTools, isRateLimited, worktreeRoot } from './deps';
import { implementerPrompt } from './prompts';
import { enforceScopeFor } from './scope';

export type Signal = 'cancel' | 'pause' | null;
export type TasksOutcome = { result: 'done' } | { result: 'blocked' | 'paused' | 'cancelled'; reason: string };

export function controlSignal(d: EngineDeps, runId: string): Signal {
  const count = (k: string): number => d.store.events(runId, k).length;
  if (count('cancel.requested') > 0) return 'cancel';
  return count('pause.requested') > count('resumed') ? 'pause' : null;
}

type TaskNode = ReturnType<EngineDeps['store']['nodes']>[number];
type TaskResult = { ok: true } | { ok: false; error: string; rateLimited: boolean };

async function runTask(d: EngineDeps, run: TaskRun, plan: Plan, node: TaskNode, cwd: string): Promise<TaskResult> {
  const interrupted = d.store.getKey(`interrupted:${run.id}:${node.id}`) !== undefined;
  const prompt = implementerPrompt({ plan, taskId: node.id, interrupted, repairNotes: undefined });
  const res = await callAgent(d, run, { role: 'implementer', prompt, cwd, allowedTools: implementerTools(d, run.id) });
  if (!res.ok) return { ok: false, error: res.error ?? 'agent failed', rateLimited: isRateLimited(res) };
  if (res.sessionId) d.store.putKey(`session:${run.id}`, res.sessionId);
  await enforceScopeFor(d, run, cwd, node.fileScopes);
  const subject = `${commitType(run.protocolId)}: ${node.title}`.slice(0, 72);
  try {
    await d.git.commitAll(cwd, subject);
  } catch (e) {
    return { ok: false, error: `commit refused (hooks are never bypassed): ${e instanceof Error ? e.message : String(e)}`, rateLimited: false };
  }
  if (run.protocolId === 'bug') await recordReproduction(d, run, plan, cwd);
  return { ok: true };
}

function reclaimInterrupted(d: EngineDeps, runId: string): void {
  for (const n of d.store.nodes(runId).filter((x) => x.state === 'RUNNING')) {
    d.store.setNodeState(runId, n.id, 'PENDING');
    d.store.putKey(`interrupted:${runId}:${n.id}`, '1');
  }
  for (const l of d.store.nodes(runId).map((n) => d.store.getLease(runId, n.id)).filter((l) => l?.state === 'ACTIVE')) {
    const pid = Number(/^w-(\d+)-/.exec(l!.workerId)?.[1]);
    if (!isPidAlive(pid)) d.store.releaseAnyLease(runId, l!.taskNodeId);
  }
}

let workerSeq = 0;
const newWorker = (): string => `w-${process.pid}-${++workerSeq}`;

async function withLease<T>(d: EngineDeps, runId: string, nodeId: string, loc: { worktreePath: string; branch: string }, fn: () => Promise<T>): Promise<{ lost: boolean; value?: T }> {
  const ttl = d.config.limits.leaseTtlMs;
  const worker = newWorker();
  const lease = d.store.acquireLease(runId, nodeId, worker, ttl, loc);
  if (!lease) throw new PlError('PL_SCHED_001', `task ${nodeId} is leased to another worker`);
  let lost = false;
  const timer = setInterval(() => {
    if (!d.store.heartbeatLease(runId, nodeId, worker, lease.generation, ttl)) lost = true;
  }, Math.max(50, Math.floor(ttl / 3)));
  timer.unref();
  try {
    const value = await fn();
    return { lost: lost || !d.store.heartbeatLease(runId, nodeId, worker, lease.generation, ttl), value };
  } finally {
    clearInterval(timer);
    d.store.releaseLease(runId, nodeId, worker, lease.generation);
  }
}

/** Greedy batch of ready nodes whose file scopes cannot collide; anything ambiguous runs alone (sequential-first). */
export function pickBatch(d: EngineDeps, runId: string, ready: readonly TaskNode[], max: number): TaskNode[] {
  const solo = (n: TaskNode): boolean => d.store.getKey(`seq:${runId}:${n.id}`) !== undefined || n.fileScopes.length === 0;
  if (max <= 1) return ready.slice(0, 1);
  const batch: TaskNode[] = [];
  for (const n of ready) {
    if (solo(n)) continue;
    if (batch.length < max && batch.every((b) => !scopesOverlap(b.fileScopes, n.fileScopes))) batch.push(n);
  }
  return batch.length > 0 ? batch : ready.slice(0, 1);
}

async function runSequential(d: EngineDeps, run: TaskRun, plan: Plan, node: TaskNode): Promise<TaskResult | 'lost'> {
  const cwd = run.worktreePath!;
  d.store.setNodeState(run.id, node.id, 'RUNNING');
  const out = await withLease(d, run.id, node.id, { worktreePath: cwd, branch: run.activeBranch! }, () => runTask(d, run, plan, node, cwd));
  return out.lost ? 'lost' : out.value!;
}

async function runInWorktree(d: EngineDeps, run: TaskRun, plan: Plan, node: TaskNode): Promise<{ node: TaskNode; branch: string; dir: string; res: TaskResult | 'lost' }> {
  const branch = `${run.activeBranch}--${node.id}`;
  const dir = join(worktreeRoot(d, run.id), node.id);
  const wt = await d.git.createWorktree(run.worktreePath!, branch, run.activeBranch!, dir);
  d.store.setNodeState(run.id, node.id, 'RUNNING');
  const out = await withLease(d, run.id, node.id, { worktreePath: wt.path, branch }, () => runTask(d, run, plan, node, wt.path));
  return { node, branch, dir, res: out.lost ? 'lost' : out.value! };
}

async function integrate(d: EngineDeps, run: TaskRun, r: Awaited<ReturnType<typeof runInWorktree>>): Promise<'ok' | 'retry' | 'blocked'> {
  const id = r.node.id;
  const merge = await d.git.mergeBranch(run.worktreePath!, r.branch);
  await d.git.removeWorktree(run.worktreePath!, r.dir);
  if (merge.ok) {
    d.store.setNodeState(run.id, id, 'DONE');
    return 'ok';
  }
  const n = Number(d.store.getKey(`conflicts:${run.id}:${id}`) ?? '0') + 1;
  d.store.audit(run.id, 'integration.conflict', 'engine', { node: id, files: merge.conflicts, attempt: n });
  d.store.setNodeState(run.id, id, n >= 2 ? 'BLOCKED' : 'PENDING');
  d.store.putKey(`seq:${run.id}:${id}`, '1');
  d.store.putKey(`conflicts:${run.id}:${id}`, String(n));
  return n >= 2 ? 'blocked' : 'retry';
}

function failNode(d: EngineDeps, runId: string, id: string, res: Exclude<TaskResult, { ok: true }> | 'lost'): TasksOutcome {
  d.store.setNodeState(runId, id, 'PENDING');
  if (res === 'lost') return { result: 'blocked', reason: `lease for ${id} was lost; result discarded` };
  d.store.setNodeState(runId, id, 'FAILED');
  return { result: res.rateLimited ? 'paused' : 'blocked', reason: `task ${id} failed: ${res.error}`.slice(0, 400) };
}

/** Runs all remaining tasks in dependency order; parallel only for provably non-overlapping scopes. */
export async function runTasks(d: EngineDeps, runId: string): Promise<TasksOutcome> {
  reclaimInterrupted(d, runId);
  for (;;) {
    const run = d.store.getRun(runId);
    const plan = getPlan(d.store, runId);
    const nodes = d.store.nodes(runId);
    const done = new Set(nodes.filter((n) => n.state === 'DONE').map((n) => n.id));
    if (done.size === nodes.length) return { result: 'done' };
    const signal = controlSignal(d, runId);
    if (signal) return { result: signal === 'cancel' ? 'cancelled' : 'paused', reason: `${signal} requested` };
    const ready = readyNodes(nodes, done, new Set(nodes.filter((n) => n.state !== 'PENDING').map((n) => n.id)));
    if (ready.length === 0) return { result: 'blocked', reason: `no runnable tasks; blocked/failed: ${nodes.filter((n) => n.state !== 'DONE').map((n) => `${n.id}=${n.state}`).join(', ')}` };
    const batch = pickBatch(d, runId, ready, d.config.limits.maxParallel);
    const out = batch.length === 1 && d.config.limits.maxParallel === 1 ? await sequentialStep(d, run, plan, batch[0]!) : await parallelStep(d, run, plan, batch);
    if (out) return out;
    d.store.setFields(runId, { headSha: await d.git.head(run.worktreePath!) });
  }
}

async function sequentialStep(d: EngineDeps, run: TaskRun, plan: Plan, node: TaskNode): Promise<TasksOutcome | null> {
  const res = await runSequential(d, run, plan, node);
  if (res !== 'lost' && res.ok) {
    d.store.setNodeState(run.id, node.id, 'DONE');
    return null;
  }
  return failNode(d, run.id, node.id, res as Exclude<TaskResult, { ok: true }> | 'lost');
}

async function parallelStep(d: EngineDeps, run: TaskRun, plan: Plan, batch: TaskNode[]): Promise<TasksOutcome | null> {
  const results = await Promise.all(batch.map((n) => runInWorktree(d, run, plan, n)));
  let blocked: string | null = null;
  for (const r of results.sort((a, b) => a.node.id.localeCompare(b.node.id))) {
    if (r.res === 'lost' || !r.res.ok) {
      const o = failNode(d, run.id, r.node.id, r.res as Exclude<TaskResult, { ok: true }> | 'lost');
      if (o.result !== 'done') blocked ??= o.reason;
      continue;
    }
    if ((await integrate(d, run, r)) === 'blocked') blocked ??= `task ${r.node.id} conflicts with already-integrated work twice`;
  }
  return blocked ? { result: 'blocked', reason: blocked } : null;
}
