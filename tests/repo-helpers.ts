import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Git } from '../src/git/git';

export const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'pl-t-')));

export function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

export async function initRepo(files: Record<string, string>): Promise<string> {
  const root = tmp();
  const git = new Git();
  await git.run(root, ['init', '-q', '-b', 'main']);
  await git.run(root, ['config', 'user.email', 'dev@example.com']);
  await git.run(root, ['config', 'user.name', 'Dev']);
  await git.run(root, ['config', 'commit.gpgsign', 'false']);
  for (const [f, c] of Object.entries(files)) write(root, f, c);
  await git.run(root, ['add', '-A']);
  await git.run(root, ['commit', '-q', '-m', 'chore: init']);
  return root;
}
