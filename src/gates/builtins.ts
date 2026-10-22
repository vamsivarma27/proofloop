import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { BuiltinOutcome, GateRunCtx } from './runner';
import { analyzeTestDiff } from './integrity';

const pass = (summary: string): BuiltinOutcome => ({ state: 'PASS', summary });
const fail = (summary: string, category: string): BuiltinOutcome => ({ state: 'FAIL', summary, category });
const blocked = (summary: string, category: string): BuiltinOutcome => ({ state: 'BLOCKED', summary, category });

export const TEST_CHANGE_SCOPE = 'test-change';
export const BEHAVIOR_CHANGE_SCOPE = 'behavior-change';

async function diffFromBase(ctx: GateRunCtx): Promise<{ diff: string; files: string[] } | null> {
  const base = ctx.store.getRun(ctx.runId).baseCommit;
  if (!base) return null;
  return { diff: await ctx.git.diff(ctx.cwd, base), files: await ctx.git.changedFiles(ctx.cwd, base) };
}

/** Fails when tests were deleted, skipped or lost assertions unless a human approved a `test-change`. */
export async function testIntegrity(ctx: GateRunCtx): Promise<BuiltinOutcome> {
  const d = await diffFromBase(ctx);
  if (!d) return blocked('no base commit recorded; cannot compare tests', 'no-base');
  const findings = analyzeTestDiff(d.diff);
  if (findings.length === 0) return pass('no weakened, skipped or deleted tests in the diff');
  if (ctx.store.hasGatedApproval(ctx.runId, TEST_CHANGE_SCOPE)) return pass(`${findings.length} test change(s) covered by an approved test-change`);
  return fail(`unapproved test weakening: ${findings.map((f) => `${f.file} (${f.kind}: ${f.detail})`).join('; ')}`, 'test-weakened');
}

const CONTRACT_FILES = /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$|\.(proto|graphql|prisma)$|(^|\/)schema\.[a-z]+$|(^|\/)migrations?\//i;

/** Refactors preserve behavior: public exports, API contracts, schema or config changes need an approved behavior-change. */
export async function contractDrift(ctx: GateRunCtx): Promise<BuiltinOutcome> {
  const d = await diffFromBase(ctx);
  if (!d) return blocked('no base commit recorded; cannot detect drift', 'no-base');
  const drift = d.files.filter((f) => CONTRACT_FILES.test(f) || /(^|\/)\.proofloop\/config\.json$/.test(f));
  const pkgChanged = d.diff.split(/^diff --git /m).some((s) => /^a\/package\.json /.test(s) && /^[-+]\s+"(main|module|types|exports|bin)"/m.test(s));
  if (pkgChanged) drift.push('package.json (public entry points)');
  const exportsChanged = /^[-+]\s*export\s/m.test(d.diff);
  if (exportsChanged) drift.push('changed `export` statements');
  if (drift.length === 0) return pass('no contract, schema, config or export changes detected');
  if (ctx.store.hasGatedApproval(ctx.runId, BEHAVIOR_CHANGE_SCOPE)) return pass(`drift approved: ${drift.join(', ')}`);
  return fail(`unapproved contract drift: ${drift.join(', ')}`, 'contract-drift');
}

export async function evidencePreserved(ctx: GateRunCtx): Promise<BuiltinOutcome> {
  const has = ctx.store.evidenceFor(ctx.runId).some((e) => e.kind === 'pre-fix-evidence');
  return has ? pass('pre-fix evidence is recorded') : blocked('record pre-fix evidence (kind pre-fix-evidence) before remediating', 'no-evidence');
}

/** Refactor baseline: unit tests must have been run green at the base commit before changing code. */
export async function baselineGreen(ctx: GateRunCtx): Promise<BuiltinOutcome> {
  const run = ctx.store.getRun(ctx.runId);
  const ev = ctx.store.evidenceFor(ctx.runId).find((e) => e.kind === 'baseline-run' && e.commit_sha === run.baseCommit && String(e.summary).startsWith('PASS'));
  return ev ? pass(`baseline green at ${run.baseCommit?.slice(0, 8)}`) : blocked('no passing baseline run recorded at the base commit', 'no-baseline');
}

export const fileChecksum = (path: string): string | null => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null);

export const coreBuiltins: Record<string, (ctx: GateRunCtx) => Promise<BuiltinOutcome>> = {
  'test-integrity': testIntegrity,
  'contract-drift': contractDrift,
  'evidence-preserved': evidencePreserved,
  'baseline-green': baselineGreen,
};
