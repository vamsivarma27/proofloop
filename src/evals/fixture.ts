import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Git } from '../git/git';

export async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pl-eval-')));
  const git = new Git();
  await git.run(root, ['init', '-q', '-b', 'main']);
  await git.run(root, ['config', 'user.email', 'eval@example.com']);
  await git.run(root, ['config', 'user.name', 'Eval']);
  await git.run(root, ['config', 'commit.gpgsign', 'false']);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  await git.run(root, ['add', '-A']);
  await git.run(root, ['commit', '-q', '-m', 'chore: fixture']);
  return root;
}

export function linkNodeModules(root: string, repoRoot: string): void {
  symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
}
