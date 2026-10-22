import { type Config, dbPath, loadConfig } from '../config';
import { type AgentRuntime } from '../agent/runtime';
import { coreBuiltins } from '../gates/builtins';
import { GhAdapter, type GithubPort, GithubSync } from '../github/adapter';
import { Git } from '../git/git';
import { loadRegistry } from '../protocol/registry';
import { detectRepo } from '../repo/detect';
import type { Clock } from '../shared/clock';
import { type Exec, nodeExec } from '../shared/exec';
import type { Logger } from '../shared/log';
import { openDb } from '../state/db';
import { Store } from '../state/store';
import { reproductionProven } from './bug';
import type { BuiltinFn } from './deps';
import { Engine } from './engine';

export interface EngineOptions {
  root: string;
  runtime: AgentRuntime;
  /** undefined => derive from config.github; null => force local-only. */
  port?: GithubPort | null;
  config?: Config;
  clock?: Clock;
  exec?: Exec;
  logger?: Logger;
  extraBuiltins?: Record<string, BuiltinFn>;
  dbFile?: string;
}

export async function createEngine(o: EngineOptions): Promise<Engine> {
  const git = new Git(o.exec ?? nodeExec);
  const config = o.config ?? loadConfig(o.root);
  const store = new Store(openDb(o.dbFile ?? dbPath(o.root)), o.clock);
  const repo = config.github.repo ?? (await git.remoteRepo(o.root));
  const port = o.port !== undefined ? o.port : config.github.enabled && repo ? new GhAdapter(repo) : null;
  return new Engine({
    root: o.root, store, config, registry: loadRegistry(o.root), git, runtime: o.runtime, github: new GithubSync(store, port), port,
    detected: detectRepo(o.root), builtins: { ...coreBuiltins, 'reproduction-proven': reproductionProven, ...o.extraBuiltins }, clock: o.clock, exec: o.exec, logger: o.logger,
  });
}
