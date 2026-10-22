import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULTS, TOPICS, fillDefaults, loadInterview, nextQuestion, recordAnswer, unanswered } from '../src/blueprint/interview';
import { publishRoadmap } from '../src/blueprint/publish';
import { renderBlueprintMarkdown, blueprintDocs } from '../src/blueprint/render';
import { type Blueprint, assumptionsVisible, validateBlueprint } from '../src/blueprint/schema';
import { getBlueprint, submitBlueprint } from '../src/blueprint/workflow';
import { approvePlan } from '../src/plan/workflow';
import { isPlError } from '../src/shared/errors';
import { agents, engineFor } from './engine-helpers';
import { makeStore, newRun } from './helpers';
import { initRepo } from './repo-helpers';
import type { GithubPort } from '../src/github/adapter';

const example = (): Blueprint => JSON.parse(readFileSync('templates/blueprint.example.json', 'utf8')) as Blueprint;
const errorsOf = (mutate: (b: Blueprint) => void): string => {
  const b = example();
  mutate(b);
  return validateBlueprint(b).errors.join(' | ');
};

describe('blueprint validation (v0.2)', () => {
  it('the shipped example is valid and surfaces what needs confirmation', () => {
    const v = validateBlueprint(example());
    expect(v.errors).toEqual([]);
    expect(v.needsConfirmation.join()).toContain('A-2');
    expect(v.needsConfirmation.join()).toContain('D-1');
    expect(assumptionsVisible(example())).toEqual([]);
  });

  it('labels research without a valid URL or timestamp as unsupported, and rejects facts that lean on it (AC3)', () => {
    expect(errorsOf((b) => { b.research[0]!.url = 'not a url'; })).toContain('not a valid http(s) URL');
    expect(errorsOf((b) => { b.research[0]!.consultedAt = 'yesterday'; })).toContain('ISO timestamp');
    expect(errorsOf((b) => { b.research[0]!.consultedAt = '2999-01-01T00:00:00Z'; })).toContain('future');
    expect(errorsOf((b) => { b.facts[1]!.findingId = 'res-404'; })).toContain('without a valid cited finding');
    const v = validateBlueprint({ ...example(), research: example().research.map((r, i) => (i === 0 ? { ...r, url: 'ftp://x' } : r)) });
    expect(v.unsupported.length).toBeGreaterThan(0);
  });

  it('checks the stack against requirements (AC4)', () => {
    expect(errorsOf((b) => { b.architecture.stack = b.architecture.stack.filter((s) => s.id !== 'S-2'); })).toMatch(/not addressed by any stack/);
    expect(errorsOf((b) => { b.architecture.stack[0]!.satisfies = ['R-404']; })).toContain('unknown requirement R-404');
    expect(errorsOf((b) => { b.architecture.stack[0]!.alternatives = []; })).toContain('alternatives');
    expect(errorsOf((b) => { b.architecture.stack[0]!.tradeoffs = ''; })).toContain('tradeoffs');
  });

  it('rejects dependency cycles in the roadmap (AC6)', () => {
    expect(errorsOf((b) => { b.roadmap.milestones[0]!.dependencies = ['M-4']; })).toContain('cycle');
    expect(errorsOf((b) => { b.roadmap.milestones[1]!.dependencies = ['M-404']; })).toContain('unknown');
  });

  it('enforces traceability: MVP features on the roadmap, functional requirements delivered, ids resolvable', () => {
    expect(errorsOf((b) => { b.roadmap.milestones = b.roadmap.milestones.map((m) => ({ ...m, featureIds: m.featureIds.filter((f) => f !== 'F-2') })).filter((m) => m.featureIds.length > 0); })).toContain('MVP feature F-2 is not on the roadmap');
    expect(errorsOf((b) => { b.features[0]!.requirementIds = ['R-404']; })).toContain('unknown requirement');
    expect(errorsOf((b) => { b.features = b.features.filter((f) => f.id !== 'F-1'); b.roadmap.milestones[0]!.featureIds = ['F-3']; })).toContain('R-1 is not delivered');
    expect(errorsOf((b) => { b.personas.push({ ...b.personas[0]! }); })).toContain('duplicate persona');
  });

  it('refuses overclaims about bugs and scale, and warns about unmeasured capacity', () => {
    expect(errorsOf((b) => { b.architecture.operational = 'Guaranteed bug-free with unlimited scalability'; })).toContain('overclaim');
    const b = example();
    delete b.requirements.find((r) => r.id === 'R-7')!.measurable;
    expect(validateBlueprint(b).warnings.join()).toContain('no measurable target');
  });

  it('flags high-impact assumptions that the approver would not see', () => {
    const b = example();
    b.roadmap.milestones[3]!.assumptionIds = [];
    b.openDecisions = [];
    expect(assumptionsVisible(b)).toEqual(['A-2']);
  });

  it('reports schema errors with paths', () => {
    expect(validateBlueprint({}).errors.length).toBeGreaterThan(3);
  });

  it('renders facts, assumptions, recommendations and research separately, with URLs and dates', () => {
    const parsed = validateBlueprint(example()).blueprint!;
    const md = renderBlueprintMarkdown(parsed, 'abc123def456', ['assumption A-2']);
    for (const h of ['## Facts', '## Assumptions', '## Recommendations', '## Research (URL, date consulted)', '## Needs your confirmation']) expect(md).toContain(h);
    expect(md).toContain('https://fastapi.tiangolo.com/features/');
    expect(blueprintDocs(parsed, 'abc', []).map((d) => d.path)).toEqual(expect.arrayContaining(['docs/product/blueprint.md', 'docs/product/roadmap.md', 'docs/decisions/0001-backend-fastapi-python.md']));
  });
});

describe('interview tracking (AC1, AC2)', () => {
  it('asks one question at a time and never re-asks what was already provided', () => {
    const { store } = makeStore();
    const run = newRun(store);
    expect(nextQuestion(loadInterview(store, run.id))?.topic).toBe('outcome');
    recordAnswer(store, run.id, 'outcome', { text: 'x', source: 'user' });
    recordAnswer(store, run.id, 'users', { text: 'sales reps', source: 'user' });
    expect(nextQuestion(loadInterview(store, run.id))?.topic).toBe('pain');
    expect(unanswered(loadInterview(store, run.id))).not.toContain('users');
  });

  it('defaults never overwrite user answers and are recorded as defaults', () => {
    const { store } = makeStore();
    const run = newRun(store);
    recordAnswer(store, run.id, 'scale', { text: '5 users', source: 'user' });
    const filled = fillDefaults(store, run.id);
    expect(filled.map((f) => f.topic)).not.toContain('scale');
    const state = loadInterview(store, run.id);
    expect(state.scale?.text).toBe('5 users');
    expect(state.constraints).toEqual({ text: DEFAULTS.constraints, source: 'default' });
    recordAnswer(store, run.id, 'scale', { text: 'ignored default', source: 'default' });
    expect(loadInterview(store, run.id).scale?.text).toBe('5 users');
    expect(nextQuestion(state)).toBeNull();
    expect(TOPICS.length).toBe(7);
  });
});

describe('idea-to-product run (v0.2, end to end)', () => {
  function fakeGithub() {
    const created: string[] = [];
    const subs: string[] = [];
    const blocks: string[] = [];
    let n = 0;
    const port: GithubPort = {
      preflight: async () => ({ ok: true, repo: 'o/r', problems: [], canWrite: true }),
      ensureIssue: async (key, title) => { const hit = created.indexOf(key); const num = hit >= 0 ? hit + 1 : (created.push(key), ++n); void title; return { number: num, nodeId: `N${num}`, url: `https://github.com/o/r/issues/${num}` }; },
      addCheckpoint: async () => undefined,
      linkSubIssue: async (p, c) => { subs.push(`${p.number}>${c.number}`); return 'linked'; },
      blockedBy: async (i, b) => { blocks.push(`${i.number}<${b.number}`); return 'linked'; },
      openPullRequest: async () => 'https://github.com/o/r/pull/3',
      getIssue: async () => ({ number: 1, title: '', body: '', state: 'open' }),
      getPullRequest: async () => ({ state: 'OPEN', checks: 'none' }),
    };
    return { port, created, subs, blocks };
  }

  async function ready(port: GithubPort | null) {
    const root = await initRepo({ 'README.md': 'demo\n' });
    const e = await engineFor(root, agents(), { port });
    const run = await e.start({ protocolId: 'idea-to-product', intent: 'A lead tracker for small sales teams' });
    return { e, root, id: run.id };
  }

  it('waits for the interview, rejects early/invalid blueprints, and never publishes before approval', async () => {
    const g = fakeGithub();
    const { e, id } = await ready(g.port);
    expect(await e.drive(id)).toMatchObject({ state: 'DISCOVERING', waiting: 'human' });
    expect(() => submitBlueprint(e.d.store, id, example())).toThrow(/interview incomplete/);
    fillDefaults(e.d.store, id);
    try {
      submitBlueprint(e.d.store, id, { nope: 1 });
    } catch (err) {
      expect(isPlError(err, 'PL_BLUEPRINT_010')).toBe(true);
    }
    expect(e.d.store.getRun(id).state).toBe('DISCOVERING');
    const sub = submitBlueprint(e.d.store, id, example());
    expect(sub.run.state).toBe('AWAITING_APPROVAL');
    expect(sub.needsConfirmation.length).toBe(2);
    expect(g.created.filter((k) => k.includes('milestone')).length).toBe(0);
    await expect(publishRoadmap(e.d.store, g.port, id, example())).rejects.toThrow(/not been approved/);
  });

  it('after approval creates the roadmap issue hierarchy once, writes docs, verifies and delivers a PR', async () => {
    const g = fakeGithub();
    const { e, id } = await ready(g.port);
    fillDefaults(e.d.store, id);
    const sub = submitBlueprint(e.d.store, id, example());
    approvePlan(e.d.store, id, { planHash: sub.hash, by: 'human:t' });
    const { Git } = await import('../src/git/git');
    const { bareRemote } = await import('./engine-helpers');
    await bareRemote(e.d.root);
    const out = await e.drive(id);
    expect(out, JSON.stringify(out)).toMatchObject({ state: 'PR_OPEN' });
    expect(g.created.filter((k) => k.includes('/milestone/')).length).toBe(4);
    expect(g.subs.length).toBe(4);
    expect(g.blocks.length).toBe(4); // M-2<M-1, M-3<M-1, M-4<M-2, M-4<M-3
    const run = e.d.store.getRun(id);
    expect(await new Git().run(run.worktreePath!, ['ls-tree', '-r', '--name-only', 'HEAD'])).toContain('docs/product/blueprint.md');
    expect(e.d.store.gateHistory(id, 'blueprint-valid').at(-1)!.state).toBe('PASS');
    expect(e.d.store.gateHistory(id, 'assumptions-visible').at(-1)!.state).toBe('PASS');
    // re-running publish does not duplicate
    await publishRoadmap(e.d.store, g.port, id, getBlueprint(e.d.store, id));
    expect(g.created.filter((k) => k.includes('/milestone/')).length).toBe(4);
  });

  it('an edited blueprint needs fresh approval before issues can be created', async () => {
    const g = fakeGithub();
    const { e, id } = await ready(g.port);
    fillDefaults(e.d.store, id);
    const a = submitBlueprint(e.d.store, id, example());
    const edited = example();
    edited.idea.oneLine = 'A lead tracker for very small sales teams';
    const b = submitBlueprint(e.d.store, id, edited);
    expect(b.hash).not.toBe(a.hash);
    expect(() => approvePlan(e.d.store, id, { planHash: a.hash, by: 'human:t' })).toThrow();
    approvePlan(e.d.store, id, { planHash: b.hash, by: 'human:t' });
    expect(e.d.store.getRun(id).approvedPlanHash).toBe(b.hash);
  });

  it('works locally without GitHub: docs are delivered, roadmap publishing is recorded as skipped', async () => {
    const { e, id } = await ready(null);
    fillDefaults(e.d.store, id);
    const sub = submitBlueprint(e.d.store, id, example());
    approvePlan(e.d.store, id, { planHash: sub.hash, by: 'human:t' });
    const out = await e.drive(id);
    expect(out.state).toBe('PR_OPEN');
    expect(e.d.store.events(id, 'roadmap.skipped').length).toBe(1);
  });
});
