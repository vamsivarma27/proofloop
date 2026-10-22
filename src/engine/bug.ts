import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GatePlanEntry } from '../gates/plan';
import type { BuiltinOutcome, GateRunCtx } from '../gates/runner';
import { evaluateCommand } from '../policy/command';
import type { Plan } from '../plan/schema';
import { sha256 } from '../shared/hash';
import { redact, scrubbedEnv } from '../shared/redact';
import type { TaskRun } from '../state/store';
import { type EngineDeps, environmentOf, policyFor } from './deps';
import { nodeExec } from '../shared/exec';

export const REPRODUCTION_GATE: GatePlanEntry = { gateId: 'reproduction-proven', kind: 'custom', required: true, command: 'builtin:reproduction-proven', source: 'builtin' };

/** After the regression-test task is committed, run it BEFORE the fix lands and record whether it failed. */
export async function recordReproduction(d: EngineDeps, run: TaskRun, plan: Plan, cwd: string): Promise<void> {
  const rt = plan.regressionTest;
  if (!rt || d.store.evidenceFor(run.id).some((e) => e.kind === 'reproduction')) return;
  if (!existsSync(join(cwd, rt.file))) return;
  const decision = evaluateCommand(rt.command, policyFor(d, run.id));
  if (decision.verdict !== 'allow') {
    d.store.audit(run.id, 'policy.denied', 'engine', { command: rt.command, class: decision.cls, reason: decision.reason, during: 'reproduction' });
    return;
  }
  const [bin, ...args] = decision.argv;
  const head = await d.git.head(cwd);
  const r = await (d.exec ?? nodeExec)(bin!, args, { cwd, timeoutMs: d.config.limits.gateTimeoutMs, env: scrubbedEnv(process.env) });
  const state = r.code === 0 ? 'PASS' : 'FAIL';
  const log = redact(`$ ${rt.command}\n${r.stdout}\n${r.stderr}`);
  const uri = join(d.root, '.proofloop', 'artifacts', run.id, `reproduction-${head.slice(0, 8)}.log`);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(uri, '..'), { recursive: true });
  writeFileSync(uri, log);
  d.store.addEvidence({ taskRunId: run.id, gateId: 'reproduction-proven', kind: 'reproduction', uri, checksum: sha256(log), commitSha: head, environment: environmentOf(d), summary: `${state}: regression test ${state === 'FAIL' ? 'fails before the fix' : 'already passes before the fix'}`, redactionStatus: 'redacted' });
}

export async function reproductionProven(ctx: GateRunCtx): Promise<BuiltinOutcome> {
  const plan = ctx.store.getPlanBody(ctx.runId) as Plan | undefined;
  if (plan?.reproduction && plan.reproduction.reproducible !== 'yes')
    return { state: 'BLOCKED', category: 'not-reproduced', summary: `bug was not reproduced (${plan.reproduction.reproducible}); request the missing reproduction details instead of guessing a fix` };
  const ev = ctx.store.evidenceFor(ctx.runId).find((e) => e.kind === 'reproduction');
  if (!ev) return { state: 'BLOCKED', category: 'no-reproduction-evidence', summary: 'no run of the regression test before the fix was recorded' };
  return String(ev.summary).startsWith('FAIL')
    ? { state: 'PASS', summary: 'regression test failed before the fix and passes now' }
    : { state: 'FAIL', category: 'regression-test-did-not-fail-first', summary: 'regression test passed before the fix, so it does not prove the bug' };
}
