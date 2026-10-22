import { execFile } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBytes?: number;
  env?: Record<string, string>;
  input?: string;
}

export interface ExecResult {
  /** null when the process could not be spawned or was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** e.g. ENOENT when the executable does not exist. */
  spawnError?: string;
}

/** Runs argv directly (never through a shell). Injectable so adapters can be contract-tested. */
export type Exec = (cmd: string, args: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const DEFAULT_EXEC_MAX_BYTES = 4 * 1024 * 1024;

export const nodeExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const maxBuffer = opts.maxBytes ?? DEFAULT_EXEC_MAX_BYTES;
    const child = execFile(
      cmd,
      [...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
        maxBuffer,
        env: opts.env,
        encoding: 'utf8',
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        const e = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        const truncated = e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        const spawnError = typeof e?.code === 'string' && !truncated ? e.code : undefined;
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: Boolean(e?.killed) && !truncated,
          truncated,
          spawnError,
        });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
