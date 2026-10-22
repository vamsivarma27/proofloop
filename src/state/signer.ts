import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * HMAC key kept outside any repository or worktree (default ~/.proofloop/ledger.key, mode 600).
 * Rows in gate_result/approval carry a signature; rows inserted by anything that lacks the key (for example
 * a script an agent wrote and a gate happened to run) fail verification and are ignored by the guards.
 * Limit: code running as the same user can read the key file. This raises the bar; it is not isolation.
 */
export interface Signer {
  sign(parts: ReadonlyArray<string | number | null>): string;
}

export function fileSigner(keyPath = process.env.PROOFLOOP_KEY_FILE ?? join(process.env.PROOFLOOP_HOME ?? join(homedir(), '.proofloop'), 'ledger.key')): Signer {
  if (!existsSync(keyPath)) {
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 });
    chmodSync(keyPath, 0o600);
  }
  const key = readFileSync(keyPath, 'utf8').trim();
  return { sign: (parts) => createHmac('sha256', key).update(JSON.stringify(parts)).digest('hex') };
}
