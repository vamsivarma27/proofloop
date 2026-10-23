import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildGatePlan } from '../gates/plan';
import { runGates } from '../gates/runner';
import type { GithubPort } from '../github/adapter';
import { PlError } from '../shared/errors';
import { stateDir } from '../config';
import { ENGINE_VERSION } from '../version';
import { type EngineDeps, artifactDir, clockOf, gateCtx } from './deps';
import { excludeStateDir } from './steps-plan';

export const TEST_PERSONAS = ['ordinary-user', 'impatient-user', 'unauthorized-user', 'accessibility'];

export type Verdict = 'pass' | 'regression' | 'pre-existing' | 'fixed' | 'fail' | 'gap';
export interface TestRow { gateId: string; kind: string; command: string | null; state: string; baseline: string | null; verdict: Verdict; category: string | null; excerpt?: string }
export interface TestBug { key: string; title: string; body: string }
export interface TestReport { engine: string; head: string; base: string | null; runId: string; rows: TestRow[]; bugs: TestBug[]; gaps: string[]; limitations: string[]; dir: string; logs: string; passed: boolean }

/** Pure: how one gate's result compares with the same gate on the base branch. */
export function verdictOf(state: string, baseline: string | null, command: string | null): Verdict {
  if (state === 'PASS') return baseline === 'FAIL' ? 'fixed' : 'pass';
  if (state === 'BLOCKED' && command === null) return 'gap';
  if (state === 'FAIL') return baseline === 'PASS' ? 'regression' : baseline === 'FAIL' ? 'pre-existing' : 'fail';
  return 'fail';
}

export function bugsOf(rows: TestRow[], head: string): TestBug[] {
  return rows.filter((r) => ['regression', 'pre-existing', 'fail'].includes(r.verdict)).map((r) => ({
    key: `test:${r.gateId}:${r.verdict}`,
    title: `${r.verdict === 'regression' ? 'Regression' : 'Failing check'}: ${r.gateId} on ${head.slice(0, 8)}`,
    body: `Gate \`${r.gateId}\` (${r.kind}) is ${r.state}${r.category ? ` (${r.category})` : ''} on commit ${head}. Base branch: ${r.baseline ?? 'not compared'}. Verdict: **${r.verdict}**${r.verdict === 'regression' ? ' - it passed on the base branch and fails now' : ''}.\n\nCommand: \`${r.command ?? 'none'}\``,
  }));
}

export function renderTestMarkdown(r: TestReport): string {
  const L = ['# ProofLoop test report', '', `Engine ${r.engine} · commit \`${r.head.slice(0, 12)}\` · base ${r.base ? `\`${r.base.slice(0, 12)}\`` : 'none (not compared)'}`, '', `**${r.passed ? 'PASSED' : 'NOT PASSED'}** - ${r.rows.filter((x) => x.verdict === 'regression').length} regression(s), ${r.bugs.length} bug(s), ${r.gaps.length} coverage gap(s)`, '', '| Check | Kind | Result | Base branch | Verdict |', '|---|---|---|---|---|'];
  for (const x of r.rows) L.push(`| ${x.gateId} | ${x.kind} | ${x.state}${x.category ? ` (${x.category})` : ''} | ${x.baseline ?? '-'} | ${x.verdict === 'regression' ? '**regression**' : x.verdict} |`);
  for (const x of r.rows) if (x.excerpt) L.push('', `### ${x.gateId} output (tail)`, '', '```', x.excerpt, '```');
  L.push('', '## Bugs', '', ...(r.bugs.length ? r.bugs.map((b) => `- **${b.title}**\n  ${b.body.split('\n').join('\n  ')}`) : ['None.']));
  L.push('', `Gate logs and evidence: \`${r.logs}\``, '', '## Not covered', '', ...(r.gaps.length ? r.gaps.map((g) => `- ${g}`) : ['None.']), '', '## Limits', '', ...r.limitations.map((x) => `- ${x}`), '');
  return L.join('\n');
}

export async function runOn(d: EngineDeps, cwd: string, head: string, intent: string, only: string[] | undefined, protocolId = 'test'): Promise<{ runId: string; plan: ReturnType<typeof buildGatePlan> }> {
  const protocol = d.registry.get(protocolId);
  const projectId = d.store.ensureProject({ name: basename(d.root), repository: await d.git.remoteRepo(d.root), defaultBranch: await d.git.defaultBranch(d.root), detectedStack: d.detected });
  const run = d.store.createRun({ projectId, protocolId: protocol.id, protocolVersion: protocol.version, intent, risk: 'high', repairBudget: 0 });
  d.store.setFields(run.id, { headSha: head, baseCommit: head, worktreePath: cwd });
  const plan = buildGatePlan(protocol, 'high', d.detected, d.config).filter((e) => !only?.length || only.includes(e.gateId) || only.includes(e.kind));
  d.store.setGatePlan(run.id, plan.map((e) => ({ gateId: e.gateId, kind: e.kind, required: e.required, command: e.command })));
  const ctx = gateCtx(d, run.id, cwd, head);
  await runGates({ ...ctx, personas: d.config.app.personas.length ? d.config.app.personas : TEST_PERSONAS }, plan);
  return { runId: run.id, plan };
}

export const stateOf = (d: EngineDeps, runId: string, gateId: string): { state: string; category: string | null } => {
  const last = d.store.gateHistory(runId, gateId).at(-1);
  return { state: last?.state ?? 'MISSING', category: last?.failureCategory ?? null };
};

/** Run the base branch in a detached worktree. Dependencies are shared by symlink, so a baseline failure may be an environment artefact (stated in the report). */
async function baselineStates(d: EngineDeps, base: string, only: string[] | undefined): Promise<Map<string, string>> {
  const dir = join(stateDir(d.root), 'worktrees', `test-base-${base.slice(0, 8)}`);
  await d.git.run(d.root, ['worktree', 'prune'], { allowFail: true });
  await d.git.run(d.root, ['worktree', 'add', '--detach', '--force', dir, base]);
  try {
    for (const m of ['node_modules', '.venv']) if (existsSync(join(d.root, m)) && !existsSync(join(dir, m))) symlinkSync(join(d.root, m), join(dir, m));
    const { runId, plan } = await runOn(d, dir, base, `test baseline ${base.slice(0, 12)}`, only);
    return new Map(plan.map((e) => [e.gateId, stateOf(d, runId, e.gateId).state]));
  } finally {
    await d.git.removeWorktree(d.root, dir);
  }
}

/** Last lines of the newest log for a gate, so the failure is readable without opening protected state files. */
export function excerptOf(dir: string, gateId: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const f = readdirSync(dir).filter((x) => x.startsWith(`${gateId}-`) && x.endsWith('.log')).sort().at(-1);
  return f ? readFileSync(join(dir, f), 'utf8').split('\n').slice(-25).join('\n') : undefined;
}

/** `proofloop test`: every applicable check on the current clean commit, compared gate by gate with the base branch. */
export async function testCurrent(d: EngineDeps, o: { cwd?: string; only?: string[]; baseline?: boolean; github?: GithubPort | null } = {}): Promise<TestReport> {
  const cwd = o.cwd ?? d.root;
  excludeStateDir(d.root);
  const head = await d.git.head(cwd);
  if (!(await d.git.isClean(cwd))) throw new PlError('PL_VERIFY_001', 'working tree has uncommitted changes; commit first so evidence maps to a commit');
  const defaultBranch = await d.git.defaultBranch(d.root);
  const base = o.baseline === false ? null : (await d.git.run(cwd, ['merge-base', head, defaultBranch], { allowFail: true })) || null;
  const comparable = base !== null && base !== head;
  const before = comparable ? await baselineStates(d, base, o.only) : new Map<string, string>();
  const { runId, plan } = await runOn(d, cwd, head, `test ${head.slice(0, 12)}`, o.only);
  const rows = plan.map((e): TestRow => {
    const now = stateOf(d, runId, e.gateId);
    const baseline = before.get(e.gateId) ?? null;
    return { gateId: e.gateId, kind: e.kind, command: e.command, state: now.state, baseline, verdict: verdictOf(now.state, baseline, e.command), category: now.category };
  });
  const required = new Set(plan.filter((e) => e.required).map((e) => e.gateId));
  const logs = join(artifactDir(d), runId);
  for (const r of rows) if (r.state === 'FAIL') r.excerpt = excerptOf(logs, r.gateId);
  const gaps = rows.filter((r) => r.verdict === 'gap').map((r) => `${r.kind}: no command detected, so nothing ${r.kind === 'browser' ? 'exercised the running application (no Playwright journeys)' : 'ran for this check'}${required.has(r.gateId) ? ' (required: this blocks a pass)' : ' (optional)'}. Add one (or ask Claude to write it) and re-run.`);
  const bugs = bugsOf(rows, head);
  const limitations = [
    comparable ? 'Regression = a check that passed on the merge base and fails now. The base ran in a detached worktree sharing this repository\'s installed dependencies; a base failure caused by that is reported as pre-existing, not as a regression.' : 'No separate base commit (you are on the base branch or comparison was off), so regressions cannot be told apart from older failures.',
    'Browser journeys are only as good as the Playwright tests the repository already has; ProofLoop runs them per persona and does not invent them here.',
    'Failing gates are bugs in the project or its tests; a BLOCKED gate (no command, no browser) is a coverage gap and is never counted as a pass.',
  ];
  const dir = join(stateDir(d.root), 'test-runs', clockOf(d).nowIso().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const report: TestReport = { engine: ENGINE_VERSION, head, base: comparable ? base : null, runId, rows, bugs, gaps, limitations, dir, logs, passed: rows.every((r) => (required.has(r.gateId) ? r.verdict === 'pass' || r.verdict === 'fixed' : r.verdict !== 'regression' && r.verdict !== 'fail' && r.verdict !== 'pre-existing')) };
  if (o.github) for (const b of bugs) await o.github.ensureIssue(b.key, b.title, b.body, ['bug']);
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, 'report.md'), renderTestMarkdown(report));
  return report;
}
