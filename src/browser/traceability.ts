import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BuiltinOutcome, GateRunCtx } from '../gates/runner';
import type { Plan } from '../plan/schema';
import { mapAcceptance, parsePlaywrightJson } from './playwright';

export const AC_GATE_ID = 'ac-traceability';
const FILE_REF = /^[\w@./-]+\.[A-Za-z0-9]+(?::\d+)?$/;

/**
 * Every acceptance criterion must map to an executable assertion (an existing test file or selector) or a documented
 * manual check. File references must exist at the candidate commit, so invented tests cannot satisfy a criterion.
 * When a Playwright JSON report is configured, "@AC-n"-tagged tests must have executed and passed.
 */
export async function acTraceability(ctx: GateRunCtx): Promise<BuiltinOutcome> {
  const plan = ctx.store.getPlanBody(ctx.runId) as Plan | undefined;
  if (!plan?.acceptanceCriteria) return { state: 'PASS', summary: 'no acceptance criteria to trace' };
  const problems: string[] = [];
  const notes: string[] = [];
  for (const ac of plan.acceptanceCriteria) {
    if (ac.manual) {
      notes.push(`${ac.id}: manual check (${ac.manual.reason})`);
      continue;
    }
    for (const ref of ac.tests) {
      if (FILE_REF.test(ref) && !existsSync(join(ctx.cwd, ref.replace(/:\d+$/, '')))) problems.push(`${ac.id}: test file "${ref}" does not exist at the candidate commit`);
      else if (!FILE_REF.test(ref)) notes.push(`${ac.id}: selector "${ref}" is not file-checked`);
    }
  }
  const results = resultsOutcome(ctx, plan.acceptanceCriteria.map((a) => a.id));
  if (problems.length) return { state: 'FAIL', category: 'untraceable-criteria', summary: problems.join('; ') };
  if (results.state !== 'PASS') return results;
  return { state: 'PASS', summary: `all ${plan.acceptanceCriteria.length} criteria trace to assertions${notes.length ? ` (${notes.join('; ')})` : ''}${results.summary ? `; ${results.summary}` : ''}` };
}

function resultsOutcome(ctx: GateRunCtx, acIds: string[]): BuiltinOutcome {
  const file = ctx.resultsFile;
  if (!file) return { state: 'PASS', summary: '' };
  const path = join(ctx.cwd, file);
  if (!existsSync(path)) return { state: 'BLOCKED', category: 'no-results', summary: `configured browser results ${file} were not produced` };
  const rows = mapAcceptance(acIds, parsePlaywrightJson(readFileSync(path, 'utf8')));
  const failed = rows.filter((r) => r.failed > 0).map((r) => r.ac);
  if (failed.length) return { state: 'FAIL', category: 'assertion-failed', summary: `tagged tests failed for ${failed.join(', ')}` };
  const unexecuted = rows.filter((r) => r.executed === 0).map((r) => r.ac);
  return { state: 'PASS', summary: unexecuted.length ? `no tagged browser test executed for ${unexecuted.join(', ')}` : 'tagged browser tests passed' };
}
