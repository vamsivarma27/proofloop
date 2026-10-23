import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GithubPort } from '../github/adapter';
import { redact } from '../shared/redact';
import type { IncidentRepo } from './incidents';
import type { DecisionReference, HistoricalMemoryResult, IncidentRecord, RegressionTestReference, RelatedGithubItem, RelatedIncident, SourceKind } from './types';

export interface RetrieveInput {
  taskId: string;
  repositoryId: string;
  intent: string;
  issueNumber?: number | undefined;
  errorText?: string | undefined;
  affectedFiles?: string[];
  headRevision: string | null;
}

export interface RetrieveDeps {
  incidents: IncidentRepo;
  port: GithubPort | null;
  root: string;
  nowIso: () => string;
  /** Files changed between a recorded revision and HEAD; null when the revision cannot be resolved. */
  changedSince?: (revision: string) => Promise<string[] | null>;
  maxResults?: number;
}

export const MIN_SCORE = 4;
const SCORE = { exactIssue: 10, errorLine: 6, errorCap: 12, tokenOverlap: 10, file: 3, fileCap: 9, testName: 2, recent: 1 } as const;
const NINETY_DAYS_MS = 90 * 86_400_000;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'into', 'page', 'user', 'users', 'make', 'add', 'fix', 'bug', 'error', 'issue', 'fails', 'failing', 'should', 'after', 'before']);

export const tokens = (text: string): Set<string> => new Set((text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
const jaccard = (a: Set<string>, b: Set<string>): number => {
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter === 0 ? 0 : inter / (a.size + b.size - inter);
};
const errorLines = (text: string): string[] => text.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l.length >= 12).slice(0, 20);
const pathsIn = (text: string): string[] => text.match(/[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|json|ya?ml|md)\b/g) ?? [];

interface Scored {
  score: number;
  reasons: string[];
}

/** Transparent scoring: every point has a named reason, and a keyword match alone cannot reach the threshold. */
export function scoreIncident(inc: IncidentRecord, q: RetrieveInput, nowMs: number): Scored {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string): void => {
    score += points;
    reasons.push(reason);
  };
  const body = [inc.title, inc.summary, ...inc.symptoms, ...inc.actualBehavior].join('\n').toLowerCase();
  if (q.issueNumber && inc.githubIssueNumber === q.issueNumber) add(SCORE.exactIssue, `linked to the task's issue #${q.issueNumber}`);
  const hits = errorLines(q.errorText ?? '').filter((l) => body.includes(l));
  if (hits.length) add(Math.min(hits.length * SCORE.errorLine, SCORE.errorCap), `same error message: "${hits[0]!.slice(0, 80)}"`);
  const overlap = jaccard(tokens(q.intent), tokens(body));
  if (overlap > 0) add(Math.round(overlap * SCORE.tokenOverlap), `similar symptoms (${Math.round(overlap * 100)}% shared terms)`);
  const mine = new Set([...(q.affectedFiles ?? []), ...pathsIn(q.intent)]);
  const shared = inc.affectedFiles.filter((f) => mine.has(f));
  if (shared.length) add(Math.min(shared.length * SCORE.file, SCORE.fileCap), `touches the same files: ${shared.slice(0, 3).join(', ')}`);
  const named = inc.regressionTests.filter((t) => [...tokens(t.name)].some((w) => tokens(q.intent).has(w)));
  if (named.length) add(SCORE.testName, `regression test ${named[0]!.name} matches the task wording`);
  if (nowMs - Date.parse(inc.updatedAt) < NINETY_DAYS_MS) score += SCORE.recent;
  return { score, reasons };
}

async function freshnessOf(inc: IncidentRecord, deps: RetrieveDeps, head: string | null): Promise<RelatedIncident['freshness']> {
  const rev = inc.relatedCommits.at(-1) ?? inc.baseRevision;
  if (!rev || !deps.changedSince) return 'UNKNOWN';
  if (rev === head) return 'CURRENT';
  const changed = await deps.changedSince(rev).catch(() => null);
  if (!changed || inc.affectedFiles.length === 0) return 'UNKNOWN';
  return inc.affectedFiles.some((f) => changed.includes(f)) ? 'POTENTIALLY_STALE' : 'CURRENT';
}

async function toRelated(inc: IncidentRecord, s: Scored, deps: RetrieveDeps, head: string | null): Promise<RelatedIncident> {
  const ok = inc.attemptedFixes.filter((a) => a.outcome === 'SUCCESS').at(-1);
  const out: RelatedIncident = {
    incidentId: inc.id, title: inc.title, summary: inc.summary, score: s.score, relevanceReason: s.reasons.join('; '),
    failedApproaches: inc.attemptedFixes.filter((a) => a.outcome === 'FAILURE' || a.outcome === 'ABANDONED').map((a) => `${a.description}${a.failureReason ? ` — failed because: ${a.failureReason}` : ''}`),
    regressionTests: inc.regressionTests, sourceUrls: [inc.githubIssueUrl, ...inc.relatedPullRequests].filter((u): u is string => Boolean(u)),
    freshness: await freshnessOf(inc, deps, head),
  };
  if (inc.confirmedRootCause) out.rootCause = inc.confirmedRootCause;
  if (ok) out.successfulApproach = ok.description;
  return out;
}

type Source = { source: SourceKind; outcome: 'ok' | 'failed' | 'skipped'; detail?: string };
const failure = (source: SourceKind, e: unknown): Source => {
  const msg = e instanceof Error ? e.message : String(e);
  return { source, outcome: 'failed', detail: `${/rate.?limit|\b403\b|\b429\b/i.test(msg) ? 'rate-limited: ' : ''}${redact(msg).slice(0, 200)}` };
};

function decisions(root: string, intent: string): DecisionReference[] {
  const dir = join(root, 'docs', 'decisions');
  if (!existsSync(dir)) return [];
  const want = tokens(intent);
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort().flatMap((file) => {
    const title = (readFileSync(join(dir, file), 'utf8').split('\n')[0] ?? '').replace(/^#\s*/, '');
    return [...tokens(title)].some((w) => want.has(w)) ? [{ file, title: redact(title).slice(0, 200) }] : [];
  });
}

async function githubItems(port: GithubPort, q: RetrieveInput): Promise<{ issues: RelatedGithubItem[]; prs: RelatedGithubItem[] }> {
  const issues: RelatedGithubItem[] = [];
  const prs: RelatedGithubItem[] = [];
  const seen = new Set<string>();
  const terms = [...tokens(q.intent)].slice(0, 6).join(' ');
  const hits = terms ? await port.searchHistory!(terms, 20) : [];
  const want = tokens(`${q.intent}\n${q.errorText ?? ''}`);
  for (const h of hits) {
    const key = `${h.isPullRequest ? 'pr' : 'issue'}:${h.number}`;
    if (seen.has(key) || h.number === q.issueNumber) continue;
    seen.add(key);
    const overlap = jaccard(want, tokens(`${h.title} ${h.body}`));
    const score = Math.round(overlap * SCORE.tokenOverlap);
    if (score < MIN_SCORE - 1) continue; // GitHub text carries no revision or file data, so it needs a stronger lexical match
    const item = { number: h.number, title: redact(h.title).slice(0, 200), state: h.state, url: h.url, score, relevanceReason: `similar wording (${Math.round(overlap * 100)}% shared terms); unverified lead` };
    (h.isPullRequest ? prs : issues).push(item);
  }
  return { issues, prs };
}

/** Never reads a failed source as "no history": each source reports ok, failed or skipped, and completeness says which. */
export async function retrieveMemory(q: RetrieveInput, deps: RetrieveDeps): Promise<HistoricalMemoryResult> {
  const max = deps.maxResults ?? 5;
  const sources: Source[] = [];
  const warnings: string[] = [];
  const nowMs = Date.parse(deps.nowIso());
  const result: HistoricalMemoryResult = { schemaVersion: 1, taskId: q.taskId, repositoryId: q.repositoryId, retrievedAt: deps.nowIso(), retrievedAtRevision: q.headRevision, completeness: 'complete', sources, relatedIncidents: [], relatedIssues: [], relatedPullRequests: [], relatedRegressionTests: [], relevantDecisions: [], warnings };

  try {
    const scored = deps.incidents.list(q.repositoryId).filter((i) => i.taskRunId !== q.taskId).map((inc) => ({ inc, s: scoreIncident(inc, q, nowMs) })).filter((x) => x.s.score >= MIN_SCORE).sort((a, b) => b.s.score - a.s.score || a.inc.id.localeCompare(b.inc.id)).slice(0, max);
    result.relatedIncidents = await Promise.all(scored.map((x) => toRelated(x.inc, x.s, deps, q.headRevision)));
    const tests = new Map<string, RegressionTestReference>();
    for (const x of scored) for (const t of x.inc.regressionTests) tests.set(t.name, t);
    result.relatedRegressionTests = [...tests.values()];
    sources.push({ source: 'incident', outcome: 'ok' });
  } catch (e) {
    sources.push(failure('incident', e));
  }

  if (!deps.port?.searchHistory) {
    sources.push({ source: 'issue', outcome: 'skipped', detail: 'GitHub is disabled or cannot search' }, { source: 'pull-request', outcome: 'skipped', detail: 'GitHub is disabled or cannot search' });
    warnings.push('GitHub history was not searched; only local incident memory was used.');
  } else {
    try {
      const { issues, prs } = await githubItems(deps.port, q);
      const covered = new Set(result.relatedIncidents.flatMap((i) => i.sourceUrls));
      result.relatedIssues = issues.filter((i) => !covered.has(i.url)).sort((a, b) => b.score - a.score || a.number - b.number).slice(0, max);
      result.relatedPullRequests = prs.sort((a, b) => b.score - a.score || a.number - b.number).slice(0, max);
      sources.push({ source: 'issue', outcome: 'ok' }, { source: 'pull-request', outcome: 'ok' });
    } catch (e) {
      sources.push(failure('issue', e), failure('pull-request', e));
    }
  }

  try {
    result.relevantDecisions = decisions(deps.root, q.intent);
    sources.push({ source: 'decision', outcome: 'ok' });
  } catch (e) {
    sources.push(failure('decision', e));
  }

  const failed = sources.filter((s) => s.outcome === 'failed');
  if (failed.length) warnings.push(`incomplete history: ${failed.map((s) => `${s.source} (${s.detail})`).join('; ')}. An empty result here does not mean no related history exists.`);
  const attempted = sources.filter((s) => s.outcome !== 'skipped');
  result.completeness = failed.length === 0 ? 'complete' : failed.length === attempted.length ? 'failed' : 'partial';
  for (const i of result.relatedIncidents) if (i.freshness !== 'CURRENT') warnings.push(`incident ${i.incidentId} is ${i.freshness}: re-check that its lesson still applies to the current code.`);
  return result;
}

/** Planner-facing text. It is context to weigh, not instructions: GitHub text is untrusted and may be stale. */
export function memoryForPrompt(m: HistoricalMemoryResult): string {
  if (m.completeness === 'failed') return `History retrieval FAILED (${m.warnings.join(' ')}). Do not assume this is a new problem.`;
  const L: string[] = [`Retrieved ${m.retrievedAt} at revision ${m.retrievedAtRevision?.slice(0, 12) ?? 'unknown'} (${m.completeness}). Weigh it against current evidence; it never overrides the acceptance criteria.`];
  for (const i of m.relatedIncidents) {
    L.push(`- Incident ${i.incidentId} "${i.title}" [${i.freshness}] — why relevant: ${i.relevanceReason}`);
    if (i.rootCause) L.push(`  confirmed root cause: ${i.rootCause}`);
    for (const f of i.failedApproaches) L.push(`  previously failed: ${f}`);
    if (i.successfulApproach) L.push(`  previously worked: ${i.successfulApproach}`);
    for (const t of i.regressionTests) L.push(`  regression test: ${t.name}${t.filePath ? ` (${t.filePath})` : ''}`);
  }
  for (const x of [...m.relatedIssues, ...m.relatedPullRequests]) L.push(`- #${x.number} "${x.title}" (${x.state}): ${x.relevanceReason}`);
  for (const d of m.relevantDecisions) L.push(`- decision record ${d.file}: ${d.title}`);
  if (L.length === 1) L.push('- no related history found.');
  for (const w of m.warnings) L.push(`! ${w}`);
  L.push('Consider: did a similar bug occur before, did a previous fix fail, does a regression test already exist, did the code change since, and does the earlier lesson apply here?');
  return L.join('\n');
}
