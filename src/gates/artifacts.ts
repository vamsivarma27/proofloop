import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { measurementSchema, evaluatePerformance, type Measurement } from '../perf/report';
import { PlError } from '../shared/errors';
import { sha256 } from '../shared/hash';
import { redact } from '../shared/redact';
import type { Store } from '../state/store';
import type { Plan } from '../plan/schema';
import type { BuiltinOutcome, GateRunCtx } from './runner';

const NAME = /^[a-z][a-z0-9-]{1,50}$/;

/** Records a named artifact (threat model, rollback notes, profiler output ...) in the append-only ledger. */
export function addArtifact(store: Store, runId: string, a: { name: string; content: string; artifactDir: string; commitSha?: string; summary?: string; kind?: string; environment?: string }): string {
  if (!NAME.test(a.name)) throw new PlError('PL_ARTIFACT_001', 'artifact names are lowercase kebab-case');
  const dir = join(a.artifactDir, runId);
  mkdirSync(dir, { recursive: true });
  const content = redact(a.content);
  const uri = join(dir, `${a.name}-${store.evidenceFor(runId).length + 1}.txt`);
  writeFileSync(uri, content);
  return store.addEvidence({ taskRunId: runId, kind: a.kind ?? `artifact:${a.name}`, uri, checksum: sha256(content), commitSha: a.commitSha, environment: a.environment ?? 'recorded', summary: (a.summary ?? a.name).slice(0, 300), redactionStatus: 'redacted' });
}

type Body = Partial<Plan> & { idea?: unknown; roadmap?: unknown; risks?: unknown[]; architecture?: { stack?: unknown[] } };

/** Artifacts the engine can prove from structured data it already validated; everything else must be recorded. */
const DERIVED: Record<string, (b: Body, s: Store, id: string) => boolean> = {
  'intent-brief': (b) => Boolean(b.intent),
  'impact-map': (b) => Boolean(b.affectedModules?.length),
  'blast-radius-map': (b) => Boolean(b.affectedModules?.length),
  'acceptance-criteria': (b) => Boolean(b.acceptanceCriteria?.length),
  'implementation-plan': (b) => Boolean(b.tasks?.length),
  'dependency-graph': (b) => Boolean(b.tasks?.length),
  'test-plan': (b) => Boolean(b.testPlan?.length),
  'regression-plan': (b) => Boolean(b.testPlan?.length),
  scope: (b) => Boolean(b.tasks?.every((t) => t.fileScopes.length)),
  'approved-plan-record': (_b, s, id) => Boolean(s.getRun(id).approvedPlanHash) && s.getRun(id).approvedPlanHash === s.getRun(id).currentPlanHash,
  'reproduction-result': (_b, s, id) => s.evidenceFor(id).some((e) => e.kind === 'reproduction'),
  'root-cause': (b) => Boolean(b.rootCause?.confirmed || b.rootCause?.uncertainty),
  'regression-test': (b) => Boolean(b.regressionTest),
  'verification-report': () => true,
  'product-blueprint': (b) => Boolean(b.idea),
  roadmap: (b) => Boolean(b.roadmap),
  'risk-register': (b) => Boolean(b.risks?.length),
  adr: (b) => Boolean(b.architecture?.stack?.length),
  baseline: (_b, s, id) => s.evidenceFor(id).some((e) => e.kind === 'perf-baseline'),
  'before-after-result': (_b, s, id) => s.evidenceFor(id).some((e) => e.kind === 'perf-after'),
};

export function missingArtifacts(store: Store, runId: string, required: readonly string[]): string[] {
  const body = (store.getPlanBody(runId) ?? {}) as Body;
  const recorded = new Set(store.evidenceFor(runId).map((e) => String(e.kind)));
  return required.filter((name) => !(recorded.has(`artifact:${name}`) || DERIVED[name]?.(body, store, runId)));
}

export const requiredArtifactsBuiltin = (required: readonly string[]) => async (ctx: GateRunCtx): Promise<BuiltinOutcome> => {
  const missing = missingArtifacts(ctx.store, ctx.runId, required);
  return missing.length === 0 ? { state: 'PASS', summary: `all ${required.length} required artifacts are present` } : { state: 'BLOCKED', category: 'missing-artifacts', summary: `missing required artifacts: ${missing.join(', ')}. Record each with \`proofloop artifact add <run> <name> --file <path>\`` };
};

const MIGRATION_PATH = /(^|\/)migrations?\/|\.sql$|(^|\/)schema\.[a-z]+$/i;
const DESTRUCTIVE_SQL = /\b(drop\s+(table|column|database|schema|index)|truncate\s+(table\s+)?\w+|delete\s+from\s+\w+(?!.*where))/i;
export const DESTRUCTIVE_MIGRATION_SCOPE = 'destructive-migration';

/** Schema changes need rollback notes; destructive statements need a human approval scoped to exactly that. */
export async function migrationReadiness(ctx: GateRunCtx): Promise<BuiltinOutcome> {
  const base = ctx.store.getRun(ctx.runId).baseCommit;
  if (!base) return { state: 'BLOCKED', category: 'no-base', summary: 'no base commit to compare migrations against' };
  const files = (await ctx.git.changedFiles(ctx.cwd, base)).filter((f) => MIGRATION_PATH.test(f));
  if (files.length === 0) return { state: 'PASS', summary: 'no migration or schema files changed' };
  const diff = await ctx.git.diff(ctx.cwd, base);
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  const destructive = DESTRUCTIVE_SQL.test(added);
  if (destructive && !ctx.store.hasGatedApproval(ctx.runId, DESTRUCTIVE_MIGRATION_SCOPE)) return { state: 'FAIL', category: 'destructive-migration-unapproved', summary: `destructive SQL in ${files.join(', ')} needs an explicit human approval (scope ${DESTRUCTIVE_MIGRATION_SCOPE}); never run against production` };
  const notes = ctx.store.evidenceFor(ctx.runId).some((e) => e.kind === 'artifact:rollback-notes');
  return notes ? { state: 'PASS', summary: `migration files ${files.join(', ')} have rollback notes${destructive ? ' and an approved destructive change' : ''}` } : { state: 'BLOCKED', category: 'missing-artifacts', summary: `migration files changed (${files.join(', ')}) but no rollback notes were recorded: rollback is more than reverting a commit when data changes are irreversible` };
}

function loadMeasurement(store: Store, runId: string, kind: string): Measurement | undefined {
  const ev = store.evidenceFor(runId).filter((e) => e.kind === kind).at(-1);
  if (!ev) return undefined;
  const parsed = measurementSchema.safeParse(JSON.parse(readFileSync(String(ev.uri), 'utf8')));
  return parsed.success ? parsed.data : undefined;
}

export async function baselineRecorded(ctx: GateRunCtx): Promise<BuiltinOutcome> {
  const b = loadMeasurement(ctx.store, ctx.runId, 'perf-baseline');
  const run = ctx.store.getRun(ctx.runId);
  if (!b) return { state: 'BLOCKED', category: 'no-baseline', summary: 'no valid baseline with workload, target and samples was recorded before optimizing' };
  if (run.baseCommit && !run.baseCommit.startsWith(b.commit) && !b.commit.startsWith(run.baseCommit)) return { state: 'BLOCKED', category: 'stale-baseline', summary: `baseline was measured at ${b.commit.slice(0, 8)}, not the base commit ${run.baseCommit.slice(0, 8)}` };
  return { state: 'PASS', summary: `baseline recorded (${b.kind}, ${b.environment})` };
}

export async function beforeAfter(ctx: GateRunCtx): Promise<BuiltinOutcome> {
  const run = ctx.store.getRun(ctx.runId);
  const after = loadMeasurement(ctx.store, ctx.runId, 'perf-after');
  if (after && run.headSha && !run.headSha.startsWith(after.commit) && !after.commit.startsWith(run.headSha)) return { state: 'BLOCKED', category: 'stale-measurement', summary: `after-measurement is for ${after.commit.slice(0, 8)}, not the candidate ${run.headSha.slice(0, 8)}` };
  const v = evaluatePerformance(loadMeasurement(ctx.store, ctx.runId, 'perf-baseline'), after);
  const label = after ? `${after.kind} measurement in ${after.environment}` : 'no measurement';
  switch (v.kind) {
    case 'TARGET_MET': return { state: 'PASS', summary: `target met: ${v.baseline.toFixed(1)} -> ${v.after.toFixed(1)} (${(v.improvement * 100).toFixed(0)}% better), ${label}` };
    case 'TARGET_NOT_MET': return { state: 'FAIL', category: 'target-not-met', summary: `improved ${(v.improvement * 100).toFixed(0)}% but the stated target was not met (${v.after.toFixed(1)}); ${label}` };
    case 'NO_SIGNIFICANT_CHANGE': return { state: 'FAIL', category: 'no-improvement', summary: `change within noise (${(v.improvement * 100).toFixed(1)}%); no performance claim is supported` };
    case 'REGRESSION': return { state: 'FAIL', category: 'perf-regression', summary: `performance regressed ${(-v.improvement * 100).toFixed(0)}%` };
    case 'INVALID': return { state: 'BLOCKED', category: 'invalid-measurement', summary: v.reason };
  }
}
