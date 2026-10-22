import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Git } from '../git/git';
import { type CommandPolicy, evaluateCommand } from '../policy/command';
import { type Clock } from '../shared/clock';
import { type Exec, nodeExec } from '../shared/exec';
import { sha256 } from '../shared/hash';
import { redact, scrubbedEnv } from '../shared/redact';
import type { GateResultRow, Store } from '../state/store';
import { ENGINE_GATE_IDS, type GateState } from '../state/machine';
import type { GatePlanEntry } from './plan';
import { type AppHandle } from '../browser/app';
import { hashDir } from '../browser/playwright';

export interface BuiltinOutcome {
  state: GateState;
  summary: string;
  category?: string;
  evidence?: Array<{ kind: string; uri: string; checksum: string }>;
}

export interface GateRunCtx {
  store: Store;
  runId: string;
  cwd: string;
  commitSha: string;
  policy: CommandPolicy;
  git: Git;
  artifactDir: string;
  timeoutMs: number;
  environment: string;
  clock: Clock;
  exec?: Exec;
  builtins?: Record<string, (ctx: GateRunCtx) => Promise<BuiltinOutcome>>;
  extraEnv?: Record<string, string>;
  /** Starts the application for browser gates; failure makes the gate BLOCKED. */
  startApp?: () => Promise<AppHandle>;
  personas?: readonly string[];
  artifactDirs?: readonly string[];
  /** Playwright JSON report (relative to cwd) used to map executed tests to acceptance criteria. */
  resultsFile?: string | undefined;
  /** dev/staging/local run freely; production needs a gate-scoped human approval. */
  environmentKind?: string;
}

export const environmentLabel = (kind: string): string => `${kind}; ${process.platform}-${process.arch}; node ${process.version}`;

/** Collapses volatile noise so "the same failure again" hashes equal across retries. */
export function failureFingerprint(output: string): string {
  const tail = output.split('\n').slice(-30).join('\n');
  const norm = tail.replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '<ts>').replace(/\b\d+(\.\d+)?\s?ms\b/g, '<dur>').replace(/\/[\w./-]+/g, '<path>').replace(/\b\d{2,}\b/g, '<n>');
  return sha256(norm).slice(0, 16);
}

function writeLog(ctx: GateRunCtx, gateId: string, content: string): { uri: string; checksum: string } {
  const dir = join(ctx.artifactDir, ctx.runId);
  mkdirSync(dir, { recursive: true });
  const uri = join(dir, `${gateId}-${ctx.commitSha.slice(0, 8)}-${ctx.store.gateHistory(ctx.runId, gateId).length + 1}.log`);
  const redacted = redact(content);
  writeFileSync(uri, redacted);
  return { uri, checksum: sha256(redacted) };
}

function record(ctx: GateRunCtx, entry: GatePlanEntry, r: { state: GateState; exitCode: number | null; summary: string; category?: string; output: string; started: string; command: string; fingerprint?: string; extra?: Array<{ kind: string; uri: string; checksum: string }> }): GateResultRow {
  const log = writeLog(ctx, entry.gateId, `$ ${r.command}\n[${r.state}] ${r.summary}\n\n${r.output}`);
  const ids = [
    ctx.store.addEvidence({ taskRunId: ctx.runId, gateId: entry.gateId, kind: 'gate-log', uri: log.uri, checksum: log.checksum, commitSha: ctx.commitSha, environment: ctx.environment, summary: redact(r.summary).slice(0, 300), redactionStatus: 'redacted' }),
    ...(r.extra ?? []).map((e) => ctx.store.addEvidence({ taskRunId: ctx.runId, gateId: entry.gateId, kind: e.kind, uri: e.uri, checksum: e.checksum, commitSha: ctx.commitSha, environment: ctx.environment, summary: r.summary.slice(0, 300), redactionStatus: 'redacted' })),
  ];
  const id = ctx.store.recordGateResult({
    taskRunId: ctx.runId, gateId: entry.gateId, state: r.state, required: entry.required, commandOrAssertion: r.command, exitCode: r.exitCode,
    evidenceIds: ids, commitSha: ctx.commitSha, startedAtUtc: r.started, finishedAtUtc: ctx.clock.nowIso(), failureCategory: r.category, fingerprint: r.fingerprint,
  });
  return ctx.store.gateHistory(ctx.runId, entry.gateId).find((g) => g.id === id)!;
}

const blocked = (ctx: GateRunCtx, entry: GatePlanEntry, started: string, category: string, summary: string): GateResultRow =>
  record(ctx, entry, { state: 'BLOCKED', exitCode: null, summary, category, output: '', started, command: entry.command ?? '(none)' });

/** Runs one gate against the exact commit and records PASS/FAIL/BLOCKED with evidence. Never throws for gate failures. */
export async function runGate(ctx: GateRunCtx, entry: GatePlanEntry): Promise<GateResultRow> {
  const started = ctx.clock.nowIso();
  if (!entry.command) return blocked(ctx, entry, started, 'command-not-detected', `no command for gate "${entry.gateId}" could be detected or configured`);
  if (ctx.environmentKind === 'production' && !ctx.store.hasGatedApproval(ctx.runId, `production:${entry.gateId}`)) {
    ctx.store.audit(ctx.runId, 'policy.denied', 'engine', { gate: entry.gateId, class: 'production', reason: 'production environment requires explicit approval immediately before the action' });
    return blocked(ctx, entry, started, 'production-environment', `gate ${entry.gateId} would act against a production environment; grant scope "production:${entry.gateId}" explicitly`);
  }
  const head = await ctx.git.head(ctx.cwd);
  if (head !== ctx.commitSha) return blocked(ctx, entry, started, 'commit-mismatch', `worktree HEAD ${head.slice(0, 8)} is not the candidate commit ${ctx.commitSha.slice(0, 8)}`);
  if (await ctx.git.hasTrackedChanges(ctx.cwd)) return blocked(ctx, entry, started, 'dirty-tree', 'tracked files differ from the candidate commit: evidence must map to a commit');

  if (entry.command.startsWith('builtin:')) {
    const fn = ctx.builtins?.[entry.command.slice('builtin:'.length)];
    if (!fn) return blocked(ctx, entry, started, 'builtin-missing', `no built-in evaluator "${entry.command}"`);
    const out = await fn(ctx);
    return record(ctx, entry, { state: out.state, exitCode: out.state === 'PASS' ? 0 : null, summary: out.summary, category: out.category, output: out.summary, started, command: entry.command, extra: out.evidence });
  }

  const decision = evaluateCommand(entry.command, ctx.policy);
  const approved = decision.verdict === 'needs_approval' && decision.approvalScope !== undefined && ctx.store.hasGatedApproval(ctx.runId, decision.approvalScope);
  if (decision.verdict === 'deny' || (decision.verdict === 'needs_approval' && !approved)) {
    ctx.store.audit(ctx.runId, 'policy.denied', 'engine', { gate: entry.gateId, command: entry.command, class: decision.cls, reason: decision.reason });
    return blocked(ctx, entry, started, 'policy-denied', `command refused by policy (${decision.cls}): ${decision.reason}`);
  }

  return execute(ctx, entry, decision.argv, started);
}

const ENV_FAILURE = /browserType\.launch|Executable doesn't exist|npx playwright install|ECONNREFUSED|net::ERR_CONNECTION_REFUSED|Target page, context or browser has been closed/i;

interface Attempt {
  persona?: string;
  run: Awaited<ReturnType<Exec>>;
  output: string;
}

async function execute(ctx: GateRunCtx, entry: GatePlanEntry, argv: string[], started: string): Promise<GateResultRow> {
  const [bin, ...args] = argv;
  const browser = entry.kind === 'browser';
  let app: AppHandle | null = null;
  if (browser && ctx.startApp) {
    try {
      app = await ctx.startApp();
    } catch (e) {
      return blocked(ctx, entry, started, 'app-start-failed', e instanceof Error ? e.message : String(e));
    }
  }
  const attempts: Attempt[] = [];
  try {
    for (const persona of browser && ctx.personas?.length ? ctx.personas : [undefined]) {
      const env = { ...scrubbedEnv(process.env), ...ctx.extraEnv, ...(app ? { APP_URL: app.url } : {}), ...(persona ? { PROOFLOOP_PERSONA: persona } : {}) };
      const run = await (ctx.exec ?? nodeExec)(bin!, args, { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs, env });
      const output = `${run.stdout}${run.stderr ? `\n--- stderr ---\n${run.stderr}` : ''}${run.truncated ? '\n[output truncated]' : ''}`;
      attempts.push({ persona, run, output });
    }
  } finally {
    await app?.stop();
  }
  return finish(ctx, entry, attempts, started);
}

function judge(a: Attempt, entry: GatePlanEntry, ctx: GateRunCtx): { state: GateState; summary: string; category?: string } {
  const { run, output } = a;
  const who = a.persona ? `[${a.persona}] ` : '';
  if (run.spawnError) return { state: 'BLOCKED', summary: `${who}could not start (${run.spawnError})`, category: 'executable-missing' };
  if (run.timedOut) return { state: 'FAIL', summary: `${who}timed out after ${ctx.timeoutMs}ms`, category: 'timeout' };
  if (run.code === 0) return { state: 'PASS', summary: `${who}exit 0` };
  if (entry.kind === 'browser' && ENV_FAILURE.test(output)) return { state: 'BLOCKED', summary: `${who}browser or test environment unavailable`, category: 'environment' };
  return { state: 'FAIL', summary: `${who}exit ${run.code}`, category: 'nonzero-exit' };
}

const RANK: Record<GateState, number> = { PASS: 0, BLOCKED: 1, FAIL: 2 };

function finish(ctx: GateRunCtx, entry: GatePlanEntry, attempts: Attempt[], started: string): GateResultRow {
  const judged = attempts.map((a) => ({ a, j: judge(a, entry, ctx) }));
  const worst = judged.reduce((w, x) => (RANK[x.j.state] > RANK[w.j.state] ? x : w));
  const output = judged.map(({ a, j }) => `${a.persona ? `=== persona ${a.persona}: ${j.state} ===\n` : ''}${a.output}`).join('\n');
  const extra = (ctx.artifactDirs ?? []).flatMap((d) => {
    const checksum = hashDir(join(ctx.cwd, d));
    return checksum ? [{ kind: 'browser-artifacts', uri: join(ctx.cwd, d), checksum }] : [];
  });
  return record(ctx, entry, {
    state: worst.j.state, exitCode: worst.a.run.code, summary: judged.length > 1 ? judged.map(({ j }) => j.summary).join('; ') : worst.j.summary, category: worst.j.category, output, started,
    command: `${entry.command}${ctx.personas?.length && entry.kind === 'browser' ? ` (personas: ${ctx.personas.join(', ')})` : ''}`, extra,
    fingerprint: worst.j.state === 'FAIL' ? failureFingerprint(output) : undefined,
  });
}

export async function runGates(ctx: GateRunCtx, entries: readonly GatePlanEntry[]): Promise<GateResultRow[]> {
  const out: GateResultRow[] = [];
  for (const e of entries) out.push(await runGate(ctx, e));
  return out;
}

export interface GateReport {
  commitSha: string | null;
  allRequiredPass: boolean;
  gates: Array<{ gateId: string; required: boolean; state: GateState | 'MISSING'; stale: boolean; evidence: string[] }>;
}

export function gateReport(store: Store, runId: string): GateReport {
  const run = store.getRun(runId);
  const gates = store.getGatePlan(runId).map((g) => {
    const last = store.gateHistory(runId, g.gateId).at(-1);
    const stale = Boolean(last && last.commitSha !== run.headSha);
    return { gateId: g.gateId, required: g.required, state: last?.state ?? ('MISSING' as const), stale, evidence: last?.evidenceIds ?? [] };
  });
  const required = gates.filter((g) => g.required);
  return { commitSha: run.headSha, allRequiredPass: required.some((g) => !ENGINE_GATE_IDS.includes(g.gateId)) && required.every((g) => g.state === 'PASS' && !g.stale), gates };
}
