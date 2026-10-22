import { checkPath, inScope } from '../policy/paths';
import type { TaskRun } from '../state/store';
import type { EngineDeps } from './deps';

/** Reverts edits outside the approved file scope or in never-writable paths; the plan is the contract. */
export async function enforceScopeFor(d: EngineDeps, run: TaskRun, cwd: string, scopes: readonly string[]): Promise<string[]> {
  const reverted: string[] = [];
  for (const { status, path } of await d.git.statusPaths(cwd)) {
    if (inScope(path, scopes) && checkPath(cwd, path, 'write').ok) continue;
    await d.git.discardPath(cwd, path, status === '??');
    reverted.push(path);
  }
  if (reverted.length) d.store.audit(run.id, 'scope.reverted', 'engine', { files: reverted, scopes });
  return reverted;
}
