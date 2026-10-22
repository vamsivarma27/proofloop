import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';

export type PathDecision = { ok: true; resolved: string } | { ok: false; reason: string };

/** Writes here are never allowed for agents: VCS internals, harness state, secrets, agent/CI config. */
const WRITE_DENY: readonly RegExp[] = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.proofloop(\/|$)/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.claude\/settings(\.local)?\.json$/,
  /(^|\/)\.github\/workflows\//,
  /(^|\/)node_modules(\/|$)/,
  /\.(pem|key|p12|pfx)$/,
  /(^|\/)id_(rsa|ed25519|ecdsa)/,
];

const READ_DENY: readonly RegExp[] = [/(^|\/)\.env(\.|$)/, /\.(pem|key|p12|pfx)$/, /(^|\/)id_(rsa|ed25519|ecdsa)/, /(^|\/)\.proofloop\/state\.db/, /(^|\/)\.aws\//, /(^|\/)\.ssh\//];

/** Resolves symlinks on the deepest existing ancestor so a link inside the root cannot point outside it. */
function realish(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    tail.unshift(basename(cur));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return resolve(realpathSync(cur), ...tail);
}

export function checkPath(root: string, target: string, mode: 'read' | 'write'): PathDecision {
  const realRoot = realpathSync(root);
  const resolved = realish(resolve(root, target));
  const rel = relative(realRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(rel) === rel) return { ok: false, reason: `path escapes the allowed root: ${target}` };
  const norm = rel.split(sep).join('/');
  const deny = mode === 'write' ? WRITE_DENY : READ_DENY;
  const hit = deny.find((re) => re.test(norm));
  if (hit) return { ok: false, reason: `${mode} to "${norm}" is denied by policy` };
  return { ok: true, resolved };
}

/** Glob-ish scope check for task file ownership: "src/a/**" owns everything below src/a. */
export function inScope(path: string, scopes: readonly string[]): boolean {
  return scopes.some((s) => {
    const base = s.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
    return path === base || path.startsWith(`${base}/`) || s === '**';
  });
}

export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  const norm = (s: string): string => (s === '**' ? '' : s.replace(/\/\*{1,2}$/, ''));
  return a.some((x) => b.some((y) => {
    const nx = norm(x);
    const ny = norm(y);
    return nx === '' || ny === '' || nx === ny || nx.startsWith(`${ny}/`) || ny.startsWith(`${nx}/`);
  }));
}
