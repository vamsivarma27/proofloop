import { existsSync } from 'node:fs';
import { type Exec, nodeExec } from '../shared/exec';
import { PlError } from '../shared/errors';
import { scrubbedEnv } from '../shared/redact';

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
}

const BRANCH_PREFIX: Record<string, string> = { feature: 'feature', bug: 'bugfix', 'idea-to-product': 'feature' };

export function branchName(protocolId: string, intent: string, runId: string): string {
  const slug = intent.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '') || 'change';
  return `${BRANCH_PREFIX[protocolId] ?? 'task'}/${slug}-${runId.slice(-6)}`;
}

export class Git {
  constructor(private readonly exec: Exec = nodeExec) {}

  async run(cwd: string, args: string[], opts: { allowFail?: boolean; timeoutMs?: number; raw?: boolean } = {}): Promise<string> {
    const r = await this.exec('git', args, { cwd, timeoutMs: opts.timeoutMs ?? 60_000, env: { ...scrubbedEnv(process.env), GIT_TERMINAL_PROMPT: '0' } });
    if (r.code !== 0 && !opts.allowFail) throw new PlError('PL_GIT_001', `git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    return opts.raw ? r.stdout : r.stdout.trim();
  }

  async isRepo(cwd: string): Promise<boolean> {
    return (await this.run(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFail: true })) === 'true';
  }

  topLevel = (cwd: string): Promise<string> => this.run(cwd, ['rev-parse', '--show-toplevel']);
  head = (cwd: string): Promise<string> => this.run(cwd, ['rev-parse', 'HEAD']);
  currentBranch = (cwd: string): Promise<string> => this.run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);

  async isClean(cwd: string): Promise<boolean> {
    return (await this.run(cwd, ['status', '--porcelain'])) === '';
  }

  async defaultBranch(cwd: string): Promise<string> {
    const ref = await this.run(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
    if (ref) return ref.replace(/^origin\//, '');
    for (const b of ['main', 'master', 'develop']) if (await this.run(cwd, ['rev-parse', '--verify', '--quiet', b], { allowFail: true })) return b;
    return this.currentBranch(cwd);
  }

  async remoteRepo(cwd: string): Promise<string | null> {
    const url = await this.run(cwd, ['remote', 'get-url', 'origin'], { allowFail: true });
    const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
    return m?.[1] ?? null;
  }

  async listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
    const out = await this.run(cwd, ['worktree', 'list', '--porcelain']);
    return out.split('\n\n').filter(Boolean).map((block) => {
      const f = Object.fromEntries(block.split('\n').map((l) => [l.split(' ')[0], l.slice(l.indexOf(' ') + 1)]));
      return { path: f.worktree as string, head: (f.HEAD as string) ?? '', branch: f.branch ? (f.branch as string).replace('refs/heads/', '') : null };
    });
  }

  /** Idempotent: re-attaching to an existing worktree for the branch returns it instead of failing. */
  async createWorktree(repo: string, branch: string, base: string, dir: string): Promise<WorktreeInfo> {
    await this.run(repo, ['worktree', 'prune'], { allowFail: true });
    const existing = (await this.listWorktrees(repo)).find((w) => w.branch === branch);
    if (existing) return existing;
    if (existsSync(dir)) throw new PlError('PL_GIT_002', `worktree path already exists and is not tracked: ${dir}`);
    const branchExists = await this.run(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });
    await this.run(repo, branchExists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, base]);
    return { path: dir, branch, head: await this.head(dir) };
  }

  async removeWorktree(repo: string, dir: string): Promise<void> {
    await this.run(repo, ['worktree', 'remove', '--force', dir], { allowFail: true });
  }

  /** Commits through the repository's own hooks; hooks are never bypassed. Returns null when there was nothing to commit. */
  async commitAll(cwd: string, message: string): Promise<string | null> {
    if (await this.isClean(cwd)) return null;
    await this.run(cwd, ['add', '-A']);
    await this.run(cwd, ['commit', '-m', message]);
    return this.head(cwd);
  }

  /** Machine-readable status: NUL-separated so odd filenames and renames are handled. */
  async statusPaths(cwd: string): Promise<Array<{ status: string; path: string }>> {
    const out = await this.run(cwd, ['status', '--porcelain=v1', '-z', '-uall'], { raw: true });
    const parts = out.split('\0').filter(Boolean);
    const res: Array<{ status: string; path: string }> = [];
    for (let i = 0; i < parts.length; i++) {
      const status = parts[i]!.slice(0, 2);
      res.push({ status, path: parts[i]!.slice(3) });
      if (status[0] === 'R' || status[0] === 'C') i++;
    }
    return res;
  }

  async discardPath(cwd: string, path: string, untracked: boolean): Promise<void> {
    if (untracked) await this.run(cwd, ['clean', '-f', '-q', '--', path]);
    else await this.run(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', path]);
  }

  async changedFiles(cwd: string, base: string): Promise<string[]> {
    const committed = await this.run(cwd, ['diff', '--name-only', `${base}...HEAD`], { allowFail: true });
    const dirty = await this.run(cwd, ['status', '--porcelain']);
    const fromStatus = dirty.split('\n').filter(Boolean).map((l) => l.slice(3));
    return [...new Set([...committed.split('\n').filter(Boolean), ...fromStatus])].sort();
  }

  diff(cwd: string, base: string): Promise<string> {
    return this.run(cwd, ['diff', `${base}...HEAD`], { allowFail: true });
  }

  /** Merge a worker branch into the current branch; on conflict abort cleanly and report the files. */
  async mergeBranch(cwd: string, branch: string): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
    const r = await this.exec('git', ['merge', '--no-ff', '--no-edit', branch], { cwd, env: { ...scrubbedEnv(process.env), GIT_TERMINAL_PROMPT: '0' } });
    if (r.code === 0) return { ok: true };
    const conflicts = (await this.run(cwd, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).split('\n').filter(Boolean);
    await this.run(cwd, ['merge', '--abort'], { allowFail: true });
    return { ok: false, conflicts };
  }

  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    const r = await this.exec('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
    return r.code === 0;
  }
}
