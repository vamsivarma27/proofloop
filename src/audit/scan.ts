import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ScanFinding { rule: string; severity: 'high' | 'medium' | 'low'; file: string; line: number; text: string; why: string }

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|rb|php|cs|sql)$/;
const SKIP = /(^|\/)(node_modules|dist|build|vendor|\.proofloop|\.git)\/|\.(test|spec)\.|(^|\/)(tests?|__tests__|e2e|scripts?|migrations?|seeds?|bin)\//;
const NOT_REQUEST_PATH = /(^|\/)(cli|config|setup|build|webpack|vite|rollup|jest|vitest|playwright)[^/]*$/;
const QUERYISH = /\b(query|find\w*|select|execute|fetch\w*|get\w*|load\w*|findOne|findUnique|request|axios|http)\s*\(/i;

interface Rule { rule: string; severity: ScanFinding['severity']; why: string; test: (line: string, ahead: string[]) => boolean }

const RULES: Rule[] = [
  { rule: 'unbounded-query', severity: 'high', why: 'reads every row; latency and memory grow with the table. Add a LIMIT/pagination.', test: (l) => (/\bselect\s+\*\s+from\s+\w+/i.test(l) && !/\b(limit|where|top)\b/i.test(l)) || /\.(findAll|find|scan)\(\s*\)/.test(l) || /\.find\(\{\s*\}\)(?!\.(limit|sort))/.test(l) },
  { rule: 'n-plus-one', severity: 'high', why: 'a query or remote call per loop iteration; cost grows with the result size. Batch or join.', test: (l, ahead) => /^\s*(for|while)\b|\.forEach\(|\.map\(\s*async/.test(l) && ahead.slice(0, 4).some((a) => /\bawait\b/.test(a) && QUERYISH.test(a)) },
  { rule: 'no-timeout', severity: 'medium', why: 'an outbound call with no timeout can hold a worker forever when the dependency hangs.', test: (l) => (/\brequests\.(get|post|put|delete)\(/.test(l) && !/timeout\s*=/.test(l)) || (/\bfetch\(\s*[^)]*\)/.test(l) && /https?:\/\//.test(l) && !/signal|timeout/.test(l)) || (/\baxios\.(get|post|put|delete)\(/.test(l) && !/timeout/.test(l)) },
  { rule: 'sync-io', severity: 'medium', why: 'blocks the event loop or thread for every request on this path. Use async I/O or do it once at startup.', test: (l) => /\b(readFileSync|writeFileSync|execSync|spawnSync)\(/.test(l) },
  { rule: 'process-local-state', severity: 'low', why: 'in-memory cache/session state is lost on restart, differs per instance, and may grow without bound. Use a shared store or bound it.', test: (l) => /^(const|let|var)\s+\w*(cache|session|store|memo)\w*\s*=\s*(new Map\(|new Set\(|\{\}|\[\])/i.test(l) },
  { rule: 'retry-without-backoff', severity: 'medium', why: 'tight retry loops multiply load on a struggling dependency. Use bounded retries with backoff and jitter.', test: (l, ahead) => /^\s*while\s*\(\s*(true|1)\s*\)/.test(l) && ahead.slice(0, 8).some((a) => /\b(retry|catch)\b/i.test(a)) && !ahead.slice(0, 12).some((a) => /(backoff|sleep|delay|setTimeout|jitter)/i.test(a)) },
];

/** Cheap, line-based scalability smells. Heuristics: they point at code to review, they do not prove a defect. */
export function scanScalability(root: string, files: readonly string[], limit = 200): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const f of files) {
    if (!CODE.test(f) || SKIP.test(f) || NOT_REQUEST_PATH.test(f)) continue;
    let text: string;
    try {
      text = readFileSync(join(root, f), 'utf8');
    } catch {
      continue;
    }
    if (text.length > 400_000) continue;
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      for (const r of RULES) if (out.length < limit && r.test(l, lines.slice(i + 1, i + 13))) out.push({ rule: r.rule, severity: r.severity, file: f, line: i + 1, text: l.trim().slice(0, 140), why: r.why });
    });
  }
  return out;
}
