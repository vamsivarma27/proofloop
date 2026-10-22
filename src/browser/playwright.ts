import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface TestOutcome {
  title: string;
  file: string;
  status: 'passed' | 'failed' | 'flaky' | 'skipped';
  acIds: string[];
}

interface Suite { title?: string; file?: string; specs?: Spec[]; suites?: Suite[] }
interface Spec { title: string; file?: string; tags?: string[]; tests?: Array<{ status?: string }> }

const AC_TAG = /@(AC-[A-Za-z0-9_.-]+)/g;
const norm = (s: string | undefined): TestOutcome['status'] => (s === 'expected' ? 'passed' : s === 'unexpected' ? 'failed' : s === 'flaky' ? 'flaky' : 'skipped');

/** Reads Playwright's JSON reporter output; acceptance criteria are linked by "@AC-n" in titles or tags. */
export function parsePlaywrightJson(raw: string): TestOutcome[] {
  const out: TestOutcome[] = [];
  const walk = (s: Suite, file: string): void => {
    for (const spec of s.specs ?? []) {
      const ids = [...new Set([...`${spec.title} ${(spec.tags ?? []).join(' ')}`.matchAll(AC_TAG)].map((m) => m[1]!))];
      const statuses = (spec.tests ?? []).map((t) => norm(t.status));
      const status = statuses.includes('failed') ? 'failed' : statuses.includes('flaky') ? 'flaky' : statuses.every((x) => x === 'skipped') ? 'skipped' : 'passed';
      out.push({ title: spec.title, file: spec.file ?? file, status, acIds: ids });
    }
    for (const child of s.suites ?? []) walk(child, child.file ?? file);
  };
  const json = JSON.parse(raw) as Suite;
  walk(json, '');
  return out;
}

export interface TraceabilityRow {
  ac: string;
  tests: string[];
  executed: number;
  failed: number;
}

/** Joins the approved acceptance criteria to what actually executed, via tags. */
export function mapAcceptance(acIds: readonly string[], outcomes: readonly TestOutcome[]): TraceabilityRow[] {
  return acIds.map((ac) => {
    const hits = outcomes.filter((o) => o.acIds.includes(ac));
    return { ac, tests: hits.map((h) => h.title), executed: hits.filter((h) => h.status !== 'skipped').length, failed: hits.filter((h) => h.status === 'failed' || h.status === 'flaky').length };
  });
}

const walkFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(join(dir, e.name)) : [join(dir, e.name)]));

/** Content hash over a directory tree (sorted paths + file hashes) so trace/screenshot sets are tamper-evident. */
export function hashDir(dir: string): string | null {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const h = createHash('sha256');
  for (const f of walkFiles(dir).sort()) {
    h.update(relative(dir, f));
    h.update(readFileSync(f));
  }
  return h.digest('hex');
}
