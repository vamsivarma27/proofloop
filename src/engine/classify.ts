import type { GateResultRow } from '../state/store';

export const FAILURE_CATEGORIES = ['code-defect', 'environment', 'infrastructure', 'timeout-rate-limit', 'permission', 'flaky-test', 'unknown'] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** What the engine does with each category: only code defects are worth an automated repair attempt. */
export const ROUTE: Record<FailureCategory, 'repair' | 'block' | 'pause'> = {
  'code-defect': 'repair',
  unknown: 'repair',
  environment: 'block',
  infrastructure: 'block',
  permission: 'block',
  'flaky-test': 'block',
  'timeout-rate-limit': 'pause',
};

const PATTERNS: ReadonlyArray<[RegExp, FailureCategory]> = [
  [/rate.?limit|\b429\b|overloaded|quota exceeded|too many requests/i, 'timeout-rate-limit'],
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|\b50[234]\b.*(gateway|unavailable)|connection reset|socket hang up|network is unreachable/i, 'infrastructure'],
  [/EACCES|permission denied|\b40[13]\b.*(forbidden|unauthori)|not authenticated|authentication failed/i, 'permission'],
  [/command not found|ENOENT|No such file or directory.*(bin|node_modules)|Cannot find module|missing (dependency|executable)|browser.*(not found|launch)/i, 'environment'],
  [/flaky|intermittent/i, 'flaky-test'],
];

export function classifyFailure(input: { category?: string | undefined; output?: string; history?: readonly Pick<GateResultRow, 'state' | 'commitSha'>[]; commitSha?: string }): FailureCategory {
  const c = input.category;
  if (c === 'command-not-detected' || c === 'executable-missing' || c === 'builtin-missing' || c === 'no-base' || c === 'not-reproduced' || c === 'no-reproduction-evidence' || c === 'no-baseline' || c === 'no-evidence' || c === 'dirty-tree' || c === 'commit-mismatch') return 'environment';
  if (c === 'policy-denied') return 'permission';
  if (c === 'timeout') return 'timeout-rate-limit';
  if (c === 'test-weakened' || c === 'contract-drift' || c === 'regression-test-did-not-fail-first') return 'code-defect';
  const sameCommit = (input.history ?? []).filter((h) => h.commitSha === input.commitSha);
  if (sameCommit.some((h) => h.state === 'PASS') && sameCommit.some((h) => h.state === 'FAIL')) return 'flaky-test';
  const text = input.output ?? '';
  for (const [re, cat] of PATTERNS) if (re.test(text)) return cat;
  return c === 'nonzero-exit' ? 'code-defect' : 'unknown';
}
