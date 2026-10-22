import { readFileSync, statSync } from 'node:fs';
import { type Exec, nodeExec } from '../shared/exec';
import { PlError } from '../shared/errors';
import { redact, scrubbedEnv } from '../shared/redact';
import { checkPath } from '../policy/paths';

export const CONTEXT_LIMITS = { files: 200, matches: 50, lines: 200, lineChars: 300, bytes: 64 * 1024, history: 20 } as const;

export interface Match {
  path: string;
  line: number;
  text: string;
}

export interface RelevantFile {
  path: string;
  score: number;
  /** Everything found by keyword search is a hypothesis until a human or test confirms it. */
  status: 'hypothesis';
}

/** Read-only, bounded repository queries. Every result has a hard cap so context cannot balloon. */
export class RepoContext {
  constructor(
    readonly root: string,
    private readonly exec: Exec = nodeExec,
  ) {}

  private git(args: string[]): Promise<{ code: number | null; stdout: string }> {
    return this.exec('git', args, { cwd: this.root, timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024, env: scrubbedEnv(process.env) });
  }

  async listFiles(opts: { limit?: number; prefix?: string } = {}): Promise<{ files: string[]; truncated: boolean }> {
    const limit = Math.min(opts.limit ?? CONTEXT_LIMITS.files, CONTEXT_LIMITS.files);
    const r = await this.git(['ls-files', '--cached', '--others', '--exclude-standard']);
    const all = r.stdout.split('\n').filter((f) => f && (!opts.prefix || f.startsWith(opts.prefix)));
    return { files: all.slice(0, limit), truncated: all.length > limit };
  }

  async searchText(pattern: string, opts: { limit?: number; fixed?: boolean; pathspec?: string } = {}): Promise<{ matches: Match[]; truncated: boolean }> {
    const limit = Math.min(opts.limit ?? CONTEXT_LIMITS.matches, CONTEXT_LIMITS.matches);
    if (pattern.length === 0 || pattern.length > 200) throw new PlError('PL_CONTEXT_001', 'pattern must be 1-200 characters');
    const args = ['grep', '-n', '-I', '--no-color', '-e', pattern, ...(opts.fixed ? ['-F'] : ['-E'])];
    if (opts.pathspec) args.push('--', opts.pathspec);
    const r = await this.git(args);
    const lines = r.stdout.split('\n').filter(Boolean);
    const matches = lines.slice(0, limit).flatMap((l): Match[] => {
      const m = /^([^:]+):(\d+):(.*)$/.exec(l);
      if (!m || checkPath(this.root, m[1]!, 'read').ok === false) return [];
      return [{ path: m[1]!, line: Number(m[2]), text: redact(m[3]!.slice(0, CONTEXT_LIMITS.lineChars)) }];
    });
    return { matches, truncated: lines.length > limit };
  }

  readFileRange(path: string, start = 1, end = start + CONTEXT_LIMITS.lines - 1): { path: string; start: number; end: number; text: string; truncated: boolean } {
    const ok = checkPath(this.root, path, 'read');
    if (!ok.ok) throw new PlError('PL_CONTEXT_002', ok.reason);
    if (statSync(ok.resolved).size > 5 * 1024 * 1024) throw new PlError('PL_CONTEXT_003', `${path} is too large to read; use searchText`);
    const lines = readFileSync(ok.resolved, 'utf8').split('\n');
    const from = Math.max(1, start);
    const to = Math.min(end, from + CONTEXT_LIMITS.lines - 1, lines.length);
    let text = lines.slice(from - 1, to).map((l) => l.slice(0, CONTEXT_LIMITS.lineChars)).join('\n');
    const truncated = to < end || text.length > CONTEXT_LIMITS.bytes;
    text = redact(text.slice(0, CONTEXT_LIMITS.bytes));
    return { path, start: from, end: to, text, truncated };
  }

  async searchSymbols(name: string, limit = 20): Promise<Match[]> {
    if (!/^[\w$.]{1,80}$/.test(name)) throw new PlError('PL_CONTEXT_004', 'symbol must be an identifier');
    const defn = `(function|class|interface|type|enum|const|let|var|def|fn|struct|trait|func)[[:space:]]+${name.replaceAll('.', '\\.')}([^A-Za-z0-9_]|$)`;
    return (await this.searchText(defn, { limit })).matches;
  }

  async relevantFiles(keywords: readonly string[], limit = 15): Promise<RelevantFile[]> {
    const scores = new Map<string, number>();
    const { files } = await this.listFiles({ limit: CONTEXT_LIMITS.files * 10 });
    for (const k of keywords.map((w) => w.toLowerCase()).filter((w) => w.length > 2).slice(0, 8)) {
      for (const f of files) if (f.toLowerCase().includes(k)) scores.set(f, (scores.get(f) ?? 0) + 3);
      const { matches } = await this.searchText(k.replace(/[^\w-]/g, ''), { fixed: true, limit: CONTEXT_LIMITS.matches });
      for (const m of matches) scores.set(m.path, (scores.get(m.path) ?? 0) + 1);
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([path, score]) => ({ path, score, status: 'hypothesis' as const }));
  }

  async recentHistory(path: string, n = 5): Promise<Array<{ sha: string; subject: string }>> {
    const ok = checkPath(this.root, path, 'read');
    if (!ok.ok) throw new PlError('PL_CONTEXT_002', ok.reason);
    const r = await this.git(['log', `-n${Math.min(n, CONTEXT_LIMITS.history)}`, '--format=%h%x09%s', '--', path]);
    return r.stdout.split('\n').filter(Boolean).map((l) => ({ sha: l.split('\t')[0]!, subject: redact(l.split('\t')[1] ?? '') }));
  }

  /** Static, bounded import graph for JS/TS: direct imports of a file and the files importing it. */
  async traceDependencies(path: string): Promise<{ imports: string[]; importedBy: string[] }> {
    const file = this.readFileRange(path, 1, CONTEXT_LIMITS.lines * 5);
    const imports = [...file.text.matchAll(/(?:from|import|require\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]!).slice(0, 50);
    const stem = path.replace(/\.[^./]+$/, '').split('/').pop() ?? path;
    const { matches } = await this.searchText(`['"]\\.{1,2}/[^'"]*${stem.replace(/[^\w-]/g, '')}['"]`, { limit: CONTEXT_LIMITS.matches });
    return { imports, importedBy: [...new Set(matches.map((m) => m.path).filter((p) => p !== path))] };
  }
}
