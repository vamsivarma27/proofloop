import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ScriptedRuntime } from '../src/agent/runtime';
import { REAL_ELIGIBLE, renderRealMarkdown, runRealEvals } from '../src/evals/real';
import { ALL_TASKS, renderEvalMarkdown, runEvals, summarizeMode } from '../src/evals/runner';

describe('eval suite shape (PRD 18)', () => {
  it('has the required categories and counts', () => {
    const n = (c: string) => ALL_TASKS.filter((t) => t.category === c).length;
    expect({ feature: n('feature'), bug: n('bug'), integration: n('integration'), browser: n('browser'), performance: n('performance'), recovery: n('recovery'), blocked: n('blocked') }).toEqual({ feature: 5, bug: 5, integration: 3, browser: 3, performance: 2, recovery: 2, blocked: 2 });
    expect(new Set(ALL_TASKS.map((t) => t.id)).size).toBe(ALL_TASKS.length);
  });

  it('scripted run: the harness makes the right call on flawed behaviour and the baseline does not', async () => {
    const rep = await runEvals({ only: ['feature-3', 'feature-4', 'feature-5', 'blocked-1'] });
    expect(rep.proofloop.every((r) => r.correct)).toBe(true);
    expect(rep.summary.proofloop.falseDeliveryRate).toBe(0);
    expect(rep.summary.proofloop.safetyIncidents).toBe(0);
    expect(rep.baseline.filter((r) => r.falseDelivery).length).toBeGreaterThanOrEqual(2);
    expect(renderEvalMarkdown(rep)).toContain('scripted');
    expect(summarizeMode([], 0).tasks).toBe(0);
  });
});

describe('schemas passed to the Claude CLI', () => {
  it('omit the draft 2020-12 $schema URI the CLI validator rejects (found by the first real run)', async () => {
    const { planJsonSchema, findingsJsonSchema } = await import('../src/engine/prompts');
    for (const s of [planJsonSchema(), findingsJsonSchema()]) {
      expect(s).not.toHaveProperty('$schema');
      expect(JSON.stringify(s)).toContain('properties');
    }
  });
});

describe('real-model mode wiring (no model is called here)', () => {
  it('keeps the directory of a failed run and names it in the notes', async () => {
    const task = ALL_TASKS.find((t) => t.id === 'feature-1-single-file')!;
    const rt = new ScriptedRuntime(async (req) => (req.role === 'planner' ? { structured: task.plan } : req.role === 'implementer' ? { text: 'did nothing', costUsd: 0.1 } : { structured: { verdict: 'approve', findings: [], unsupportedClaims: [] }, costUsd: 0.01 }));
    const rep = await runRealEvals({ only: ['feature-1'], perTaskUsd: 1, totalUsd: 5, runtime: rt });
    const kept = rep.baseline[0]!.notes.find((n) => n.startsWith('kept for diagnosis: '))!;
    expect(kept).toBeDefined();
    expect(existsSync(kept.replace('kept for diagnosis: ', ''))).toBe(true);
  });

  it('only offers tasks that need no scripted crash, recorder, browser or destructive setup', () => {
    const ids = ALL_TASKS.filter(REAL_ELIGIBLE).map((t) => t.id);
    expect(ids).toContain('feature-1-single-file');
    expect(ids.some((i) => i.startsWith('browser') || i.startsWith('recovery') || i.startsWith('performance') || i.startsWith('blocked'))).toBe(false);
  });

  it('runs both arms through an injected runtime, honours the budget, and labels the report', async () => {
    const task = ALL_TASKS.find((t) => t.id === 'feature-1-single-file')!;
    const rt = new ScriptedRuntime(async (req) => {
      if (req.role === 'planner') return { structured: task.plan };
      if (req.role === 'implementer') {
        await task.implement({ cwd: req.cwd, attempt: 1, taskId: /Implement ONLY task (\S+):/.exec(req.prompt)?.[1] ?? 'task-1', isRepair: false });
        return { text: 'done', costUsd: 0.25 };
      }
      return { structured: { verdict: 'approve', findings: [], unsupportedClaims: [] }, costUsd: 0.05 };
    });
    const rep = await runRealEvals({ only: ['feature-1'], perTaskUsd: 1, totalUsd: 5, runtime: rt });
    expect(rep.runtime).toBe('claude');
    expect(rep.proofloop[0]).toMatchObject({ mode: 'proofloop', correct: true });
    expect(rep.baseline[0]).toMatchObject({ mode: 'baseline', correct: true });
    expect(rep.totalCostUsd).toBeGreaterThan(0);
    expect(renderRealMarkdown(rep)).toContain('real-model evaluation report');
    const again = await runRealEvals({ only: ['feature-1'], perTaskUsd: 1, totalUsd: 5, runtime: rt, reuse: rep });
    expect(again.baseline[0]).toEqual(rep.baseline[0]);
    expect(again.totalCostUsd).toBeLessThan(rep.totalCostUsd + rep.totalCostUsd); // baseline spend is carried, not paid twice
    const none = await runRealEvals({ only: ['feature-1'], perTaskUsd: 1, totalUsd: 0, runtime: rt });
    expect(none.proofloop).toEqual([]);
  });
});

describe('test suites (proofloop test)', () => {
  it('runs one named suite end to end, writes log and report, and finds no bugs in a healthy suite', async () => {
    const { runSuites } = await import('../src/evals/suites');
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'pl-suite-'));
    const rep = await runSuites({ root, suites: ['blocked'] });
    expect(rep.outcomes.length).toBe(2);
    expect(rep.failed).toBe(0);
    expect(readFileSync(join(rep.dir, 'log.jsonl'), 'utf8')).toContain('task.end');
    expect(readFileSync(join(rep.dir, 'report.md'), 'utf8')).toContain('None found.');
  });

  it('rejects unknown suites and turns a wrong outcome into a bug that can be filed once', async () => {
    const { runSuites, bugsOf } = await import('../src/evals/suites');
    type TaskOutcome = import('../src/evals/types').TaskOutcome;
    await expect(runSuites({ root: '/nonexistent', suites: ['nope'] })).rejects.toThrow(/unknown suite/);
    const bad = { id: 't', category: 'bug', mode: 'proofloop', expected: 'verified', finalState: 'BLOCKED', delivered: false, accepted: false, regressed: false, correct: false, falseDelivery: false, repairs: 1, firstPass: false, safetyIncidents: 1, evidenceProblems: 0, recovered: null, integrationConflicts: 0, elapsedMs: 1, notes: ['x'] } satisfies TaskOutcome;
    expect(bugsOf({ ...bad }).map((b) => b.key)).toEqual(['test:t:wrong outcome', 'test:t:safety incident']);
  });
});
