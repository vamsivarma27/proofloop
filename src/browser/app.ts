import { spawn } from 'node:child_process';
import { type CommandPolicy, evaluateCommand } from '../policy/command';
import { PlError } from '../shared/errors';
import { type Exec, nodeExec } from '../shared/exec';
import { scrubbedEnv } from '../shared/redact';

export interface AppHandle {
  url: string;
  stop(): Promise<void>;
}

export interface AppOptions {
  cwd: string;
  start: string;
  url: string;
  seed?: string | undefined;
  timeoutMs: number;
  policy: CommandPolicy;
  exec?: Exec;
  extraEnv?: Record<string, string>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

function checked(line: string, policy: CommandPolicy): string[] {
  const d = evaluateCommand(line, policy);
  if (d.verdict !== 'allow') throw new PlError('PL_APP_001', `app command refused by policy (${d.cls}): ${d.reason}`);
  return d.argv;
}

/** Starts the app from an approved command, seeds known data, waits for readiness; always stoppable. */
export async function startApp(o: AppOptions): Promise<AppHandle> {
  const env = { ...scrubbedEnv(process.env), ...o.extraEnv };
  if (o.seed) {
    const [bin, ...args] = checked(o.seed, o.policy);
    const r = await (o.exec ?? nodeExec)(bin!, args, { cwd: o.cwd, env, timeoutMs: o.timeoutMs });
    if (r.code !== 0) throw new PlError('PL_APP_002', `seed command failed (exit ${r.code}): ${r.stderr.slice(0, 200)}`);
  }
  const [bin, ...args] = checked(o.start, o.policy);
  const child = spawn(bin!, args, { cwd: o.cwd, env, detached: true, stdio: 'ignore' });
  let exited: number | null | undefined;
  child.on('exit', (code) => (exited = code ?? -1));
  child.on('error', () => (exited = -1));
  const stop = async (): Promise<void> => {
    if (exited !== undefined || child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await sleep(300);
    if (exited === undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  const deadline = Date.now() + o.timeoutMs;
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new PlError('PL_APP_003', `app exited before becoming ready (code ${exited})`);
    if (await reachable(o.url)) return { url: o.url, stop };
    await sleep(150);
  }
  await stop();
  throw new PlError('PL_APP_004', `app did not become ready at ${o.url} within ${o.timeoutMs}ms`);
}
