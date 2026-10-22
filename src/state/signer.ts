import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * HMAC key kept outside any repository or worktree (default ~/.proofloop/ledger.key, mode 600).
 * Rows in gate_plan/gate_result/approval carry a signature; rows written by anything that lacks the key (for example
 * a script an agent wrote and a gate happened to run) fail verification and are ignored by the guards.
 * Limit: code running as the same user can read the key file. This raises the bar; it is not isolation.
 */
export interface Signer {
  sign(parts: ReadonlyArray<string | number | null>): string;
}

const MIN_KEY_CHARS = 64;

function loadKey(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); // exclusive: never overwrite another process's key
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  chmodSync(path, 0o600);
  for (let i = 0; i < 20; i++) {
    const key = readFileSync(path, 'utf8').trim();
    if (key.length >= MIN_KEY_CHARS) return key;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); // another process may still be writing it
  }
  throw new Error(`ledger key ${path} is empty or too short; delete it to generate a new one (existing runs will fail verification)`);
}

export function fileSigner(keyPath = process.env.PROOFLOOP_KEY_FILE ?? join(process.env.PROOFLOOP_HOME ?? join(homedir(), '.proofloop'), 'ledger.key')): Signer {
  const key = loadKey(keyPath);
  return { sign: (parts) => createHmac('sha256', key).update(JSON.stringify(parts)).digest('hex') };
}
