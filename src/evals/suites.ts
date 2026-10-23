import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GithubPort } from '../github/adapter';
import { ENGINE_VERSION } from '../version';
import { ALL_TASKS, runProofLoop } from './runner';
import type { Category, TaskOutcome } from './types';

export const SUITES: Record<Category, string> = {
  feature: 'plan, approve, implement, verify, deliver a feature',
  bug: 'reproduce first, regression test, fix, verify',
  integration: 'parallel tasks, worktrees, merge integration',
  browser: 'real browser gate with screenshots as evidence',
  performance: 'baseline, change, comparison against a target',
  recovery: 'a run killed mid-flight resumes from stored state',
  blocked: 'work that must stop and report instead of delivering',
};

export interface TestBug { key: string; suite: Category; task: string; title: string; body: string }
export interface SuiteReport { engine: string; startedAt: string; dir: string; suites: Category[]; outcomes: TaskOutcome[]; bugs: TestBug[]; passed: number; failed: number }

/** Anything that is not the right call, plus any safety or evidence problem, is a bug in ProofLoop. */
export function bugsOf(o: TaskOutcome): TestBug[] {
  const out: TestBug[] = [];
  const add = (what: string) => out.push({ key: `test:${o.id}:${what}`, suite: o.category, task: o.id, title: `Test suite: ${o.id} — ${what}`, body: `Suite \`${o.category}\`, task \`${o.id}\`, engine ${ENGINE_VERSION}.\n\nExpected: ${o.expected}. Final state: ${o.finalState}. Delivered: ${o.delivered}. Accepted: ${o.accepted}. Repairs: ${o.repairs}.\n\nNotes:\n${o.notes.map((n) => `- ${n}`).join('\n') || '- none'}` });
  if (!o.correct) add('wrong outcome');
  if (o.safetyIncidents) add('safety incident');
  if (o.evidenceProblems) add('evidence integrity problem');
  return out;
}

export function renderSuiteMarkdown(r: SuiteReport): string {
  const L = ['# ProofLoop test run', '', `Engine ${r.engine} · ${r.startedAt} · suites: ${r.suites.join(', ')}`, '', `**${r.passed} passed, ${r.failed} failed**`, '', '| Suite | Task | Expected | Final state | Result | Repairs | Time |', '|---|---|---|---|---|---|---|'];
  for (const o of r.outcomes) L.push(`| ${o.category} | ${o.id} | ${o.expected} | ${o.finalState} | ${o.correct && !o.safetyIncidents && !o.evidenceProblems ? 'pass' : '**FAIL**'} | ${o.repairs} | ${o.elapsedMs} ms |`);
  L.push('', '## Bugs', '', ...(r.bugs.length ? r.bugs.map((b) => `- **${b.title}**\n${b.body.split('\n').map((x) => `  ${x}`).join('\n')}`) : ['None found.']));
  L.push('', 'The agent is a deterministic script, so this tests ProofLoop (gates, policy, recovery, evidence), not model quality. Log: `log.jsonl` next to this file.', '');
  return L.join('\n');
}

/** Run the chosen suites (all when none are named) end to end through the real engine and write log, report and bug list. */
export async function runSuites(o: { root: string; suites?: string[]; github?: GithubPort; log?: (l: string) => void; now?: () => Date }): Promise<SuiteReport> {
  const names = o.suites?.length ? o.suites : (Object.keys(SUITES) as Category[]);
  const unknown = names.filter((n) => !(n in SUITES));
  if (unknown.length) throw new Error(`unknown suite: ${unknown.join(', ')} (available: ${Object.keys(SUITES).join(', ')})`);
  const startedAt = (o.now?.() ?? new Date()).toISOString();
  const dir = join(o.root, '.proofloop', 'test-runs', startedAt.replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  const log = (event: string, data: object = {}) => { lines.push(JSON.stringify({ at: new Date().toISOString(), event, ...data })); o.log?.(`${event} ${(data as { task?: string }).task ?? ''}`.trim()); };
  const outcomes: TaskOutcome[] = [];
  for (const suite of names as Category[]) {
    log('suite.start', { suite });
    for (const t of ALL_TASKS.filter((x) => x.category === suite)) {
      log('task.start', { suite, task: t.id, intent: t.intent });
      const r = await runProofLoop(t).catch((e: unknown): TaskOutcome => ({ id: t.id, category: t.category, mode: 'proofloop', expected: t.expect, finalState: 'ERROR', delivered: false, accepted: null, regressed: false, correct: false, falseDelivery: false, repairs: 0, firstPass: false, safetyIncidents: 0, evidenceProblems: 0, recovered: null, integrationConflicts: 0, elapsedMs: 0, notes: [e instanceof Error ? e.message : String(e)] }));
      outcomes.push(r);
      log('task.end', { suite, task: t.id, outcome: r });
    }
    log('suite.end', { suite });
  }
  const bugs = outcomes.flatMap(bugsOf);
  if (o.github) for (const b of bugs) { await o.github.ensureIssue(b.key, b.title, b.body, ['bug']); log('bug.filed', { task: b.task, key: b.key }); }
  const failed = new Set(bugs.map((b) => b.task)).size;
  const report: SuiteReport = { engine: ENGINE_VERSION, startedAt, dir, suites: names as Category[], outcomes, bugs, passed: outcomes.length - failed, failed };
  writeFileSync(join(dir, 'log.jsonl'), `${lines.join('\n')}\n`);
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, 'report.md'), renderSuiteMarkdown(report));
  return report;
}
