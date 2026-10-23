import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GithubPort, HistoryHit } from '../src/github/adapter';
import { IncidentRepo } from '../src/memory/incidents';
import { MIN_SCORE, retrieveMemory, scoreIncident, memoryForPrompt, type RetrieveDeps } from '../src/memory/retrieve';
import { FakeClock } from '../src/shared/clock';
import { openDb } from '../src/state/db';
import { allowedTransitions, isAllowedTransition } from '../src/state/machine';
import { advance, makeStore, newRun } from './helpers';
import { tmp } from './repo-helpers';

const NOW = new FakeClock().nowIso();
const base = { repositoryId: 'o/r', headRevision: 'head1', taskId: 'run_x' };
const repoOf = () => new IncidentRepo(openDb(':memory:'), new FakeClock());
const ev = (description: string) => ({ type: 'gate-evidence', description, recordedAt: NOW });

function seed(repo: IncidentRepo) {
  const id = repo.create({ repositoryId: 'o/r', title: 'Search times out on large workspaces', summary: 'Document search times out when a workspace has 200 files', githubIssueNumber: 42, githubIssueUrl: 'https://github.com/o/r/issues/42', baseRevision: 'old1', symptoms: ['search request exceeds the deadline'], actualBehavior: ['ConnectionError: deadline exceeded while retrieving documents'] });
  repo.link(id, 'affected-file', 'src/search/retrieval.ts', 'engine');
  repo.recordAttempt(id, { id: 'a1', description: 'truncate eligible documents to 50', outcome: 'FAILURE', failureReason: 'silently omitted eligible documents' }, 'engine');
  repo.recordAttempt(id, { id: 'a2', description: 'embed documents concurrently', outcome: 'SUCCESS', commitSha: 'old2' }, 'engine');
  repo.addRegressionTest(id, { name: 'search-completeness.test.ts', filePath: 'tests/search-completeness.test.ts', lastResult: 'PASS', lastVerifiedRevision: 'old2' }, 'engine');
  return id;
}

describe('incident records', () => {
  it('creates one incident per run, idempotently, and folds its history', () => {
    const { store } = makeStore();
    const run = newRun(store);
    const repo = new IncidentRepo(store.db, new FakeClock());
    const a = repo.create({ taskRunId: run.id, repositoryId: 'o/r', title: 't', summary: 's', symptoms: ['x'], githubIssueNumber: 7 });
    expect(repo.create({ taskRunId: run.id, repositoryId: 'o/r', title: 'again', summary: 's' })).toBe(a);
    expect(repo.get(a)).toMatchObject({ status: 'OPEN', githubIssueNumber: 7, symptoms: ['x'], taskRunId: run.id });
    expect(repo.forRun(run.id)).toBe(a);
  });

  it('keeps a hypothesis separate from a confirmed root cause; an agent cannot confirm by assertion', () => {
    const repo = repoOf();
    const id = repo.create({ repositoryId: 'o/r', title: 't', summary: 's' });
    const h = repo.addHypothesis(id, 'sequential embedding is the bottleneck', 'agent:planner');
    expect(repo.get(id)!.rootCauseHypotheses[0]).toMatchObject({ status: 'UNVERIFIED' });
    expect(repo.get(id)!.confirmedRootCause).toBeUndefined();
    expect(() => repo.setHypothesisStatus(id, h, 'CONFIRMED', 'agent:planner')).toThrow(/PL_INCIDENT_001/);
    expect(() => repo.confirmRootCause(id, 'it is the cache', 'agent:implementer')).toThrow(/evidence or a human/);
    repo.setHypothesisStatus(id, h, 'CONFIRMED', 'engine', [ev('reproduction failed before the fix')]);
    expect(repo.get(id)).toMatchObject({ status: 'ROOT_CAUSE_IDENTIFIED', confirmedRootCause: 'sequential embedding is the bottleneck' });
    const id2 = repo.create({ repositoryId: 'o/r', title: 't2', summary: 's' });
    repo.confirmRootCause(id2, 'a human decided', 'human:vamsi@host');
    expect(repo.get(id2)!.confirmedRootCause).toBe('a human decided');
  });

  it('preserves failed attempts when a later attempt succeeds, and ignores replays', () => {
    const repo = repoOf();
    const id = seed(repo);
    expect(repo.recordAttempt(id, { id: 'a1', description: 'truncate eligible documents to 50', outcome: 'FAILURE' }, 'engine')).toBe(false);
    const attempts = repo.get(id)!.attemptedFixes;
    expect(attempts.map((a) => `${a.id}:${a.outcome}`)).toEqual(['a1:FAILURE', 'a2:SUCCESS']);
    expect(attempts[0]).toMatchObject({ failureReason: 'silently omitted eligible documents' });
  });

  it('links regression tests, commits, pull requests and files, and reopens or supersedes', () => {
    const repo = repoOf();
    const id = seed(repo);
    repo.link(id, 'commit', 'abc', 'engine');
    repo.link(id, 'pull-request', 'https://github.com/o/r/pull/9', 'engine');
    repo.setStatus(id, 'CLOSED', 'engine');
    repo.reopen(id, 'engine', 'regressed after a refactor');
    const next = repo.supersede(id, { repositoryId: 'o/r', title: 'Search times out again', summary: 'recurrence' });
    expect(repo.get(id)).toMatchObject({ status: 'REOPENED', relatedCommits: ['abc'], relatedPullRequests: ['https://github.com/o/r/pull/9'], affectedFiles: ['src/search/retrieval.ts'] });
    expect(repo.get(id)!.regressionTests[0]).toMatchObject({ name: 'search-completeness.test.ts', lastResult: 'PASS' });
    expect(repo.get(next)!.supersedes).toBe(id);
  });

  it('is append-only at the database level and survives a restart', () => {
    const file = join(tmp(), 'state.db');
    const a = new IncidentRepo(openDb(file), new FakeClock());
    const id = seed(a);
    expect(() => a['db'].prepare('DELETE FROM incident_entry').run()).toThrow(/append-only/);
    expect(() => a['db'].prepare("UPDATE incident SET title = 'x'").run()).toThrow(/immutable/);
    const b = new IncidentRepo(openDb(file), new FakeClock());
    expect(b.get(id)).toEqual(a.get(id));
  });

  it('redacts credentials before they are stored', () => {
    const repo = repoOf();
    const token = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
    const id = repo.create({ repositoryId: 'o/r', title: 't', summary: 's', symptoms: [`token ${token} leaked`] });
    expect(JSON.stringify(repo.get(id))).not.toContain(token);
  });
});

describe('historical retrieval', () => {
  const deps = (repo: IncidentRepo, over: Partial<RetrieveDeps> = {}): RetrieveDeps => ({ incidents: repo, port: null, root: tmp(), nowIso: () => NOW, ...over });
  const hit = (n: number, title: string, body = '', pr = false): HistoryHit => ({ number: n, title, body, state: 'closed', url: `https://github.com/o/r/${pr ? 'pull' : 'issues'}/${n}`, isPullRequest: pr });
  const port = (search: GithubPort['searchHistory']): GithubPort => ({ searchHistory: search }) as unknown as GithubPort;

  it('finds the incident by exact issue reference, similar symptoms, and matching error message, with reasons and sources', async () => {
    const repo = repoOf();
    const id = seed(repo);
    const byIssue = await retrieveMemory({ ...base, intent: 'something unrelated', issueNumber: 42 }, deps(repo));
    expect(byIssue.relatedIncidents[0]).toMatchObject({ incidentId: id, sourceUrls: ['https://github.com/o/r/issues/42'] });
    expect(byIssue.relatedIncidents[0]!.relevanceReason).toContain('issue #42');
    const bySymptom = await retrieveMemory({ ...base, intent: 'Search times out when the workspace has 200 documents, deadline exceeded' }, deps(repo));
    expect(bySymptom.relatedIncidents[0]!.relevanceReason).toContain('similar symptoms');
    const byError = await retrieveMemory({ ...base, intent: 'documents are missing', errorText: 'ConnectionError: deadline exceeded while retrieving documents\n  at fetch' }, deps(repo));
    expect(byError.relatedIncidents[0]!.relevanceReason).toContain('same error message');
  });

  it('carries failed approaches, the successful approach, the regression test and the root cause', async () => {
    const repo = repoOf();
    const id = seed(repo);
    repo.confirmRootCause(id, 'sequential embedding', 'human:me@h');
    const r = await retrieveMemory({ ...base, intent: 'Search times out on workspaces with 200 files', issueNumber: 42 }, deps(repo));
    const i = r.relatedIncidents[0]!;
    expect(i.failedApproaches[0]).toContain('truncate eligible documents');
    expect(i.failedApproaches[0]).toContain('silently omitted');
    expect(i.successfulApproach).toBe('embed documents concurrently');
    expect(i.rootCause).toBe('sequential embedding');
    expect(r.relatedRegressionTests.map((t) => t.name)).toEqual(['search-completeness.test.ts']);
    expect(memoryForPrompt(r)).toContain('previously failed: truncate eligible documents');
  });

  it('shares affected files as evidence of relevance, and ranks the stronger match first', async () => {
    const repo = repoOf();
    const strong = seed(repo);
    repo.create({ repositoryId: 'o/r', title: 'Search timeout in the preview pane', summary: 'preview search timeout', symptoms: ['preview timeout'] });
    const r = await retrieveMemory({ ...base, intent: 'Search timeout on large workspace', affectedFiles: ['src/search/retrieval.ts'] }, deps(repo));
    expect(r.relatedIncidents[0]!.incidentId).toBe(strong);
    expect(r.relatedIncidents[0]!.relevanceReason).toContain('src/search/retrieval.ts');
  });

  it('rejects an unrelated incident and a lone keyword match', async () => {
    const repo = repoOf();
    seed(repo);
    const none = await retrieveMemory({ ...base, intent: 'Add dark mode toggle to the settings page' }, deps(repo));
    expect(none.relatedIncidents).toEqual([]);
    expect(none.completeness).toBe('complete');
    const inc = repo.list('o/r')[0]!;
    expect(scoreIncident(inc, { ...base, intent: 'search' }, Date.parse(NOW)).score).toBeLessThan(MIN_SCORE);
  });

  it('marks an incident stale when its files changed since the fix, current when they did not, unknown otherwise', async () => {
    const repo = repoOf();
    const id = seed(repo);
    const q = { ...base, intent: 'Search times out on large workspaces', issueNumber: 42 };
    repo.link(id, 'commit', 'old2', 'engine');
    expect((await retrieveMemory(q, deps(repo, { changedSince: async () => ['src/search/retrieval.ts'] }))).relatedIncidents[0]!.freshness).toBe('POTENTIALLY_STALE');
    expect((await retrieveMemory(q, deps(repo, { changedSince: async () => ['README.md'] }))).relatedIncidents[0]!.freshness).toBe('CURRENT');
    const unknown = await retrieveMemory(q, deps(repo, { changedSince: async () => null }));
    expect(unknown.relatedIncidents[0]!.freshness).toBe('UNKNOWN');
    expect(unknown.warnings.join(' ')).toContain('UNKNOWN');
  });

  it('searches GitHub issues and pull requests, drops duplicates and the task issue, and keeps only strong lexical matches', async () => {
    const repo = repoOf();
    const hits = [hit(10, 'Search retrieval timeout on large workspace', 'documents search timeout workspace large'), hit(10, 'Search retrieval timeout on large workspace', 'dup'), hit(11, 'Fix search retrieval timeout workspace', 'timeout large workspace documents', true), hit(12, 'Update logo colours', 'brand'), hit(99, 'Search timeout large workspace documents', 'the task itself')];
    const r = await retrieveMemory({ ...base, intent: 'Search retrieval timeout on large workspace documents', issueNumber: 99 }, deps(repo, { port: port(async () => hits) }));
    expect(r.relatedIssues.map((x) => x.number)).toEqual([10]);
    expect(r.relatedPullRequests.map((x) => x.number)).toEqual([11]);
    expect(r.sources.filter((s) => s.outcome === 'ok').map((s) => s.source)).toEqual(['incident', 'issue', 'pull-request', 'decision']);
  });

  it('reports GitHub failure and rate limiting as incomplete retrieval, never as "no history"', async () => {
    const repo = repoOf();
    seed(repo);
    const down = await retrieveMemory({ ...base, intent: 'Search times out on large workspaces', issueNumber: 42 }, deps(repo, { port: port(async () => { throw new Error('gh api failed: HTTP 403 rate limit exceeded'); }) }));
    expect(down.completeness).toBe('partial');
    expect(down.relatedIncidents).toHaveLength(1);
    expect(down.sources.find((s) => s.source === 'issue')).toMatchObject({ outcome: 'failed' });
    expect(down.sources.find((s) => s.source === 'issue')!.detail).toContain('rate-limited');
    expect(down.warnings.join(' ')).toContain('does not mean no related history');
    const broken = repoOf();
    broken['db'].exec('DROP TRIGGER incident_no_delete; DROP TABLE incident_entry; DROP TABLE incident');
    const badRoot = tmp();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(badRoot, 'docs'), { recursive: true });
    writeFileSync(join(badRoot, 'docs', 'decisions'), 'a file where a directory should be');
    const dead = await retrieveMemory({ ...base, intent: 'search failure timeout' }, { ...deps(broken), port: port(async () => { throw new Error('offline'); }), root: badRoot });
    expect(dead.completeness).toBe('failed');
    expect(memoryForPrompt(dead)).toContain('FAILED');
  });

  it('notes when GitHub was not searched at all, and finds decision records by title', async () => {
    const repo = repoOf();
    const root = tmp();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
    writeFileSync(join(root, 'docs', 'decisions', '0001.md'), '# Search retrieval must never truncate documents\n');
    const r = await retrieveMemory({ ...base, intent: 'Search retrieval timeout' }, deps(repo, { root }));
    expect(r.relevantDecisions).toEqual([{ file: '0001.md', title: 'Search retrieval must never truncate documents' }]);
    expect(r.sources.find((s) => s.source === 'issue')).toMatchObject({ outcome: 'skipped' });
    expect(r.warnings[0]).toContain('GitHub history was not searched');
  });
});

describe('RETRIEVING_MEMORY state', () => {
  it('sits between DISCOVERING and PLANNING and keeps the old path valid', () => {
    expect(allowedTransitions('DISCOVERING')).toEqual(expect.arrayContaining(['RETRIEVING_MEMORY', 'PLANNING']));
    expect(allowedTransitions('RETRIEVING_MEMORY')).toEqual(['PLANNING', 'BLOCKED', 'CANCELLED']);
    expect(isAllowedTransition('RETRIEVING_MEMORY', 'RUNNING')).toBe(false);
    expect(isAllowedTransition('NEW', 'RETRIEVING_MEMORY')).toBe(false);
  });

  it('is enforced by the store: invalid jumps are refused, a duplicate transition is not applied twice', () => {
    const { store } = makeStore();
    const run = newRun(store);
    advance(store, run.id, 'DISCOVERING', 'RETRIEVING_MEMORY');
    expect(() => store.transition(run.id, 'RUNNING', { actor: 't' })).toThrow();
    expect(() => store.transition(run.id, 'RETRIEVING_MEMORY', { actor: 't' })).toThrow();
    advance(store, run.id, 'PLANNING');
    expect(store.getRun(run.id).state).toBe('PLANNING');
  });

  it('can be cancelled or blocked and resumed through the allowed paths', () => {
    const { store } = makeStore();
    const run = newRun(store);
    advance(store, run.id, 'DISCOVERING', 'RETRIEVING_MEMORY', 'BLOCKED', 'RETRIEVING_MEMORY', 'CANCELLED');
    expect(store.getRun(run.id).state).toBe('CANCELLED');
  });
});
