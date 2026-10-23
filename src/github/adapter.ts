import { type Exec, nodeExec } from '../shared/exec';
import { PlError } from '../shared/errors';
import { redact, scrubbedEnv } from '../shared/redact';
import type { Store } from '../state/store';

/** Hidden marker in every ProofLoop-authored body/comment; makes creation idempotent across retries and machines. */
export const marker = (key: string): string => `<!-- proofloop:key=${key} -->`;
const MAX_BODY = 60_000;

export interface IssueRef {
  number: number;
  nodeId: string;
  url: string;
}

export interface HistoryHit {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  isPullRequest: boolean;
}

export interface Preflight {
  ok: boolean;
  repo: string | null;
  problems: string[];
  canWrite: boolean;
}

export interface GithubPort {
  preflight(): Promise<Preflight>;
  ensureIssue(key: string, title: string, body: string, labels?: string[], milestone?: string): Promise<IssueRef>;
  addCheckpoint(issue: IssueRef, key: string, body: string): Promise<void>;
  linkSubIssue(parent: IssueRef, child: IssueRef): Promise<'linked' | 'unsupported'>;
  blockedBy(issue: IssueRef, blocker: IssueRef): Promise<'linked' | 'unsupported'>;
  openPullRequest(input: { head: string; base: string; title: string; body: string; cwd: string }): Promise<string>;
  getIssue(number: number): Promise<{ number: number; title: string; body: string; state: string }>;
  /** Optional: issues and pull requests in this repository matching the terms (historical memory). */
  searchHistory?(terms: string, limit: number): Promise<HistoryHit[]>;
  getPullRequest(url: string): Promise<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; checks: 'success' | 'failure' | 'pending' | 'none' }>;
}

export class GhCliError extends PlError {}

/** All GitHub I/O via the `gh` CLI; no token handling here. Injectable exec keeps it contract-testable. */
export class GhAdapter implements GithubPort {
  constructor(
    readonly repo: string,
    private readonly exec: Exec = nodeExec,
  ) {}

  private async gh(args: string[], opts: { input?: string; cwd?: string } = {}): Promise<string> {
    const r = await this.exec('gh', args, { timeoutMs: 60_000, env: scrubbedEnv(process.env, ['PATH', 'HOME', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'XDG_CONFIG_HOME', 'LANG']), ...opts });
    if (r.spawnError === 'ENOENT') throw new GhCliError('PL_GH_001', 'the GitHub CLI (gh) is not installed');
    if (r.code !== 0) throw new GhCliError('PL_GH_002', `gh ${args.slice(0, 3).join(' ')} failed: ${redact(r.stderr || r.stdout).trim().slice(0, 400)}`);
    return r.stdout.trim();
  }

  async preflight(): Promise<Preflight> {
    const problems: string[] = [];
    const auth = await this.exec('gh', ['auth', 'status'], { timeoutMs: 20_000 });
    if (auth.spawnError === 'ENOENT') return { ok: false, repo: null, problems: ['gh CLI not installed'], canWrite: false };
    if (auth.code !== 0) problems.push('gh is not authenticated; run `gh auth login`');
    let canWrite = false;
    try {
      const out = await this.gh(['repo', 'view', this.repo, '--json', 'viewerPermission,nameWithOwner', '--jq', '[.nameWithOwner,.viewerPermission]|@tsv']);
      const [, perm] = out.split('\t');
      canWrite = ['WRITE', 'MAINTAIN', 'ADMIN', 'TRIAGE'].includes(perm ?? '');
      if (!canWrite) problems.push(`insufficient permission on ${this.repo} (${perm ?? 'none'}); need issue write access`);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
    return { ok: problems.length === 0, repo: this.repo, problems, canWrite };
  }

  private login: string | null = null;
  private async me(): Promise<string> {
    return (this.login ??= await this.gh(['api', 'user', '--jq', '.login']));
  }

  private async findByMarker(key: string): Promise<IssueRef | null> {
    const q = `"proofloop:key=${key}" in:body`;
    const out = await this.gh(['api', '-X', 'GET', 'search/issues', '-f', `q=repo:${this.repo} is:issue ${q}`, '--jq', `.items[] | select(.user.login == "${await this.me()}") | [.number,.node_id,.html_url,.body] | @json`]);
    for (const line of out.split('\n').filter(Boolean)) {
      const [number, nodeId, url, body] = JSON.parse(line) as [number, string, string, string];
      if (body.includes(marker(key))) return { number, nodeId, url };
    }
    return null;
  }

  /** Create-or-return: local idempotency key first, then marker search (covers lost local state), then create. */
  async ensureIssue(key: string, title: string, body: string, labels: string[] = [], milestone?: string): Promise<IssueRef> {
    const found = await this.findByMarker(key);
    if (found) return found;
    const args = ['api', `repos/${this.repo}/issues`, '-f', `title=${redact(title)}`, '-f', `body=${redact(body).slice(0, MAX_BODY)}\n\n${marker(key)}`];
    for (const l of labels) args.push('-f', `labels[]=${l}`);
    if (milestone) args.push('-f', `milestone=${milestone}`);
    const out = await this.gh([...args, '--jq', '[.number,.node_id,.html_url]|@json']);
    const [number, nodeId, url] = JSON.parse(out) as [number, string, string];
    return { number, nodeId, url };
  }

  async addCheckpoint(issue: IssueRef, key: string, body: string): Promise<void> {
    const tag = marker(key);
    const existing = await this.gh(['api', `repos/${this.repo}/issues/${issue.number}/comments`, '--paginate', '--jq', `.[] | select(.user.login == "${await this.me()}") | .body`]);
    if (existing.includes(tag)) return;
    await this.gh(['api', `repos/${this.repo}/issues/${issue.number}/comments`, '-f', `body=${redact(body).slice(0, MAX_BODY)}\n\n${tag}`]);
  }

  private async mutate(query: string, vars: Record<string, string>): Promise<'linked' | 'unsupported'> {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [k, v] of Object.entries(vars)) args.push('-f', `${k}=${v}`);
    try {
      await this.gh(args);
      return 'linked';
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (/already|duplicate|has already been taken/i.test(msg)) return 'linked';
      if (/Field .* doesn't exist|undefinedField|Unknown|not enabled|Resource not accessible/i.test(msg)) return 'unsupported';
      throw e;
    }
  }

  linkSubIssue(parent: IssueRef, child: IssueRef): Promise<'linked' | 'unsupported'> {
    return this.mutate('mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){issue{id}}}', { p: parent.nodeId, c: child.nodeId });
  }

  blockedBy(issue: IssueRef, blocker: IssueRef): Promise<'linked' | 'unsupported'> {
    return this.mutate('mutation($i:ID!,$b:ID!){addBlockedBy(input:{issueId:$i,blockingIssueId:$b}){issue{id}}}', { i: issue.nodeId, b: blocker.nodeId });
  }

  async openPullRequest(input: { head: string; base: string; title: string; body: string; cwd: string }): Promise<string> {
    const existing = await this.gh(['pr', 'list', '--repo', this.repo, '--head', input.head, '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""'], { cwd: input.cwd });
    if (existing) return existing;
    return this.gh(['pr', 'create', '--repo', this.repo, '--head', input.head, '--base', input.base, '--title', redact(input.title), '--body', redact(input.body).slice(0, MAX_BODY)], { cwd: input.cwd });
  }

  async getPullRequest(url: string): Promise<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; checks: 'success' | 'failure' | 'pending' | 'none' }> {
    const j = JSON.parse(await this.gh(['pr', 'view', url, '--json', 'state,statusCheckRollup'])) as { state: 'OPEN' | 'MERGED' | 'CLOSED'; statusCheckRollup?: Array<{ conclusion?: string; status?: string }> };
    const rollup = j.statusCheckRollup ?? [];
    const bad = rollup.some((c) => ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(c.conclusion ?? ''));
    const pending = rollup.some((c) => c.status !== undefined && c.status !== 'COMPLETED');
    return { state: j.state, checks: rollup.length === 0 ? 'none' : bad ? 'failure' : pending ? 'pending' : 'success' };
  }

  async searchHistory(terms: string, limit: number): Promise<HistoryHit[]> {
    const q = `repo:${this.repo} ${terms.replace(/[^\w\s-]/g, ' ')} sort:updated-desc`;
    const out = await this.gh(['api', '-X', 'GET', 'search/issues', '-f', `q=${q}`, '-f', `per_page=${Math.min(limit, 30)}`, '--jq', '.items[] | [.number,.title,(.body // "")[0:600],.state,.html_url,(.pull_request != null)] | @json']);
    return out.split('\n').filter(Boolean).map((l) => {
      const [number, title, body, state, url, isPullRequest] = JSON.parse(l) as [number, string, string, string, string, boolean];
      return { number, title, body: redact(body), state, url, isPullRequest };
    });
  }

  async getIssue(number: number): Promise<{ number: number; title: string; body: string; state: string }> {
    const out = await this.gh(['api', `repos/${this.repo}/issues/${number}`, '--jq', '{number,title,body,state}']);
    const j = JSON.parse(out) as { number: number; title: string; body: string | null; state: string };
    return { ...j, body: j.body ?? '' };
  }
}

/**
 * Durable sync over any GithubPort: stores the stable node id + number, and when GitHub is unreachable queues the
 * write in the outbox and reports `queued` — never pretends remote state was updated (PRD 11.5).
 */
export class GithubSync {
  constructor(
    private readonly store: Store,
    private readonly port: GithubPort | null,
  ) {}

  get enabled(): boolean {
    return this.port !== null;
  }

  async ensureParent(runId: string, title: string, body: string, labels: string[] = []): Promise<{ status: 'synced'; issue: IssueRef } | { status: 'queued' | 'disabled' }> {
    if (!this.port) return { status: 'disabled' };
    const cached = this.store.getKey(`issue:${runId}`);
    if (cached) return { status: 'synced', issue: JSON.parse(cached) as IssueRef };
    try {
      const issue = await this.port.ensureIssue(`run/${runId}`, title, body, labels);
      this.store.putKey(`issue:${runId}`, JSON.stringify(issue));
      this.store.setFields(runId, { sourceIssueId: issue.nodeId, sourceIssueNumber: issue.number });
      this.store.audit(runId, 'github.issue', 'engine', { number: issue.number });
      return { status: 'synced', issue };
    } catch (e) {
      this.store.enqueue(runId, 'ensure-parent', `parent:${runId}`, { title, body, labels });
      this.store.audit(runId, 'github.unavailable', 'engine', { error: e instanceof Error ? e.message : String(e) });
      return { status: 'queued' };
    }
  }

  async checkpoint(runId: string, name: string, body: string): Promise<'synced' | 'queued' | 'disabled'> {
    if (!this.port) return 'disabled';
    const cached = this.store.getKey(`issue:${runId}`);
    const key = `checkpoint:${runId}:${name}`;
    try {
      if (!cached) throw new PlError('PL_GH_003', 'parent issue not synced yet');
      await this.port.addCheckpoint(JSON.parse(cached) as IssueRef, key, body);
      return 'synced';
    } catch {
      this.store.enqueue(runId, 'checkpoint', key, { name, body });
      return 'queued';
    }
  }

  /** Replays queued writes after GitHub comes back; safe to run repeatedly (markers dedupe). */
  async flush(runId?: string): Promise<{ done: number; pending: number }> {
    if (!this.port) return { done: 0, pending: this.store.pendingOutbox(runId).length };
    let done = 0;
    for (const item of this.store.pendingOutbox(runId)) {
      const run = item.key.split(':')[1] ?? '';
      const p = item.payload as { title?: string; body?: string; labels?: string[]; name?: string };
      const result = item.kind === 'ensure-parent' ? (await this.ensureParent(run, p.title!, p.body!, p.labels)).status : await this.checkpoint(run, p.name!, p.body!);
      this.store.markOutbox(item.id, result === 'synced' ? 'DONE' : 'PENDING');
      if (result === 'synced') done++;
    }
    return { done, pending: this.store.pendingOutbox(runId).length };
  }
}
