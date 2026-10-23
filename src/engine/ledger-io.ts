import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ProofLedger, buildLedger, renderLedgerSummary } from '../ledger/ledger';
import { stateDir } from '../config';
import { type EngineDeps } from './deps';
import { repositoryIdOf, storedMemory } from './memory';

/** The ledger for a run, with the parts the store does not hold (changed files, repository) resolved from Git. */
export async function ledgerFor(d: EngineDeps, runId: string): Promise<ProofLedger> {
  const run = d.store.getRun(runId);
  const cwd = run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : null;
  const changedFiles = cwd && run.baseCommit ? await d.git.changedFiles(cwd, run.baseCommit).catch(() => undefined) : undefined;
  return buildLedger(d.store, runId, { ...(changedFiles ? { changedFiles } : {}), memory: storedMemory(d, runId), repository: await repositoryIdOf(d) });
}

/** Durable local copy, plus a short summary on the GitHub issue (queued if GitHub is down, deduped by its key). */
export async function publishLedger(d: EngineDeps, runId: string, label: string): Promise<ProofLedger> {
  const ledger = await ledgerFor(d, runId);
  const dir = join(stateDir(d.root), 'ledgers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), `${JSON.stringify(ledger, null, 2)}\n`);
  await d.github.checkpoint(runId, `ledger-${label}-${(ledger.task.headRevision ?? 'none').slice(0, 8)}`, renderLedgerSummary(ledger));
  return ledger;
}
