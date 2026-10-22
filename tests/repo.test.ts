import { FAKE_GH_TOKEN } from './fake-secrets';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Git, branchName } from '../src/git/git';
import { RepoContext } from '../src/repo/context';
import { detectRepo } from '../src/repo/detect';
import { analyzeTestDiff } from '../src/gates/integrity';
import { initRepo, tmp, write } from './repo-helpers';

describe('detectRepo', () => {
  it('reports nothing for an empty directory and does not invent commands (AC4)', () => {
    const d = detectRepo(tmp());
    expect(d.commands).toEqual({});
    expect(d.limitations.join()).toContain('no recognised project files');
    expect(d.limitations.join()).toContain('no unit command detected');
  });

  it('detects pnpm scripts, start commands and CI', () => {
    const root = tmp();
    write(root, 'package.json', JSON.stringify({ scripts: { lint: 'x', typecheck: 'x', test: 'x', build: 'x', 'test:e2e': 'x', dev: 'x' } }));
    write(root, 'pnpm-lock.yaml', '');
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(join(root, '.github/workflows/ci.yml'), '');
    const d = detectRepo(root);
    expect(d.packageManager).toBe('pnpm');
    expect(d.commands).toMatchObject({ lint: 'pnpm run lint', typecheck: 'pnpm run typecheck', unit: 'pnpm run test', build: 'pnpm run build', browser: 'pnpm run test:e2e' });
    expect(d.startCommands).toEqual(['pnpm run dev']);
    expect(d.ci).toEqual(['.github/workflows/ci.yml']);
    expect(d.limitations).toEqual([]);
  });

  it('detects python, go, rust and make', () => {
    const py = tmp();
    write(py, 'pyproject.toml', '[tool.ruff]\n[tool.pytest.ini_options]\n');
    write(py, 'uv.lock', '');
    expect(detectRepo(py).commands).toMatchObject({ unit: 'uv run pytest', lint: 'uv run ruff check .' });
    const go = tmp();
    write(go, 'go.mod', 'module x');
    expect(detectRepo(go).commands.unit).toBe('go test ./...');
    const rs = tmp();
    write(rs, 'Cargo.toml', '[package]');
    expect(detectRepo(rs).commands.build).toBe('cargo build');
    const mk = tmp();
    write(mk, 'Makefile', 'test:\n\techo\nlint:\n\techo\n');
    expect(detectRepo(mk).commands).toMatchObject({ unit: 'make test', lint: 'make lint' });
  });

  it('survives invalid package.json', () => {
    const root = tmp();
    write(root, 'package.json', '{nope');
    expect(detectRepo(root).limitations.join()).toContain('not valid JSON');
  });
});

describe('RepoContext (bounded, read-only)', () => {
  it('lists, searches, reads ranges and caps output', async () => {
    const root = await initRepo({ 'src/a.ts': 'export function pagination() {}\nconst k = 1;\n', 'src/b.ts': "import { pagination } from './a';\n", '.env': `TOKEN=${FAKE_GH_TOKEN}\n`, README: 'x\n' });
    const ctx = new RepoContext(root);
    expect((await ctx.listFiles({ limit: 2 })).truncated).toBe(true);
    const found = await ctx.searchText('pagination', { fixed: true });
    expect(found.matches.map((m) => m.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(ctx.readFileRange('src/a.ts', 1, 1).text).toContain('pagination');
    expect(() => ctx.readFileRange('.env')).toThrow(/denied/);
    expect(() => ctx.readFileRange('../x')).toThrow();
    expect((await ctx.searchText('TOKEN', { fixed: true })).matches.every((m) => !m.text.includes('ghp_'))).toBe(true);
    expect((await ctx.searchSymbols('pagination')).length).toBe(1);
    const rel = await ctx.relevantFiles(['pagination']);
    expect(rel[0]).toMatchObject({ path: 'src/a.ts', status: 'hypothesis' });
    const deps = await ctx.traceDependencies('src/a.ts');
    expect(deps.importedBy).toEqual(['src/b.ts']);
    expect((await ctx.recentHistory('src/a.ts')).length).toBe(1);
    await expect(ctx.searchText('')).rejects.toThrow();
  });
});

describe('Git worktrees', () => {
  it('creates an idempotent isolated worktree, commits, diffs and merges', async () => {
    const root = await initRepo({ 'a.txt': '1\n' });
    const git = new Git();
    const base = await git.head(root);
    const dir = join(tmp(), 'wt1');
    const wt = await git.createWorktree(root, 'feature/x-1', 'HEAD', dir);
    expect((await git.createWorktree(root, 'feature/x-1', 'HEAD', dir)).path).toBe(wt.path);
    write(dir, 'b.txt', '2\n');
    expect(await git.isClean(dir)).toBe(false);
    expect(await git.changedFiles(dir, base)).toContain('b.txt');
    const sha = await git.commitAll(dir, 'feat: add b');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.commitAll(dir, 'feat: nothing')).toBeNull();
    expect(await git.diff(dir, base)).toContain('+2');
    expect(await git.isClean(root)).toBe(true); // main checkout untouched
    expect(await git.mergeBranch(root, 'feature/x-1')).toEqual({ ok: true });
    expect(await git.isAncestor(root, sha!, 'HEAD')).toBe(true);
    await git.removeWorktree(root, dir);
  });

  it('aborts conflicting merges cleanly and reports files', async () => {
    const root = await initRepo({ 'a.txt': 'base\n' });
    const git = new Git();
    const d1 = join(tmp(), 'w1');
    const d2 = join(tmp(), 'w2');
    await git.createWorktree(root, 'feature/a', 'HEAD', d1);
    await git.createWorktree(root, 'feature/b', 'HEAD', d2);
    write(d1, 'a.txt', 'one\n');
    write(d2, 'a.txt', 'two\n');
    await git.commitAll(d1, 'feat: one');
    await git.commitAll(d2, 'feat: two');
    expect(await git.mergeBranch(root, 'feature/a')).toEqual({ ok: true });
    const r = await git.mergeBranch(root, 'feature/b');
    expect(r).toEqual({ ok: false, conflicts: ['a.txt'] });
    expect(await git.isClean(root)).toBe(true);
  });

  it('names branches per the ZySec convention', () => {
    expect(branchName('feature', 'Add pagination to the Users page!', 'run_abcdef123456')).toBe('feature/add-pagination-to-the-users-page-123456');
    expect(branchName('bug', 'x', 'run_000001')).toMatch(/^bugfix\//);
    expect(branchName('performance', 'x', 'run_000001')).toMatch(/^task\//);
  });

  it('refuses to reuse an untracked directory as a worktree', async () => {
    const root = await initRepo({ 'a.txt': '1\n' });
    const dir = tmp();
    await expect(new Git().createWorktree(root, 'feature/q', 'HEAD', dir)).rejects.toThrow(/already exists/);
  });
});

describe('test integrity analysis', () => {
  const diff = (file: string, body: string): string => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${body}\n`;
  it('flags removed assertions, skips and deleted tests; ignores source files', () => {
    expect(analyzeTestDiff(diff('src/a.test.ts', "-  expect(a).toBe(1);\n+  // gone"))[0]?.kind).toBe('assertions-removed');
    expect(analyzeTestDiff(diff('tests/x.ts', "+it.skip('x', () => {})"))[0]?.kind).toBe('test-skipped');
    expect(analyzeTestDiff('diff --git a/tests/x.ts b/tests/x.ts\ndeleted file mode 100644\n')[0]?.kind).toBe('test-deleted');
    expect(analyzeTestDiff(diff('src/a.ts', '-expect(a)\n+nothing'))).toEqual([]);
    expect(analyzeTestDiff(diff('src/a.test.ts', '-expect(a).toBe(1)\n+expect(a).toBe(2)'))).toEqual([]);
    expect(analyzeTestDiff(diff('src/a.test.ts', '-expect(a).toBe(1)\n+expect(a).toEqual(1)'))).toEqual([]);
  });

  it('judges plan-declared test files with unconventional names, counting assertion tokens not lines', () => {
    const weakened = diff('check.js', "-process.exit(f(1)===1&&f(2)===2?0:1)\n+process.exit(f(1)===1?0:1)");
    expect(analyzeTestDiff(weakened)).toEqual([]); // unknown name: not treated as a test by convention
    expect(analyzeTestDiff(weakened, ['check.js'])[0]?.kind).toBe('assertions-removed');
    expect(analyzeTestDiff(diff('check.js', '-process.exit(f(1)===1?0:1)\n+process.exit(f(1)===1&&f(2)===2?0:1)'), ['check.js'])).toEqual([]);
  });
});
