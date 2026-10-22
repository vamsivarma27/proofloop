export interface IntegrityFinding {
  file: string;
  kind: 'test-deleted' | 'assertions-removed' | 'test-skipped' | 'harness-changed';
  detail: string;
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/i;
const ASSERT = /\b(expect|assert\w*|should|toBe\w*|toEqual|t\.(Error|Fatal|Fail)\w*)\b|===|!==|\bprocess\.exit\(/g;
const SKIP = /\b(it|test|describe)\.(skip|todo|fixme|failing)\b|\bx(it|describe)\(|@pytest\.mark\.(skip|xfail)|\bpytest\.(skip|xfail)\(|@unittest\.skip|\bt\.Skip\(|\.only\(/;

/** Files that define how tests run: weakening them (e.g. scripts.test = "exit 0") weakens every test at once. */
const HARNESS_FILE = /(^|\/)(vitest|jest|playwright|karma|cypress)\.config\.[a-z]+$|(^|\/)(pytest\.ini|conftest\.py|tox\.ini|\.mocharc[^/]*|setup\.cfg)$|(^|\/)Makefile$/;
const SCRIPT_LINE = /^[-+]\s*"(test|lint|typecheck|build|check)[^"]*"\s*:/;

export const isTestFile = (path: string): boolean => TEST_FILE.test(path);

/**
 * Heuristic guard against "making the build pass" by weakening tests (PRD 15.3, v0.4 AC5).
 * It flags; a human-approved scope `test-change` is required to proceed. It does not prove tests are good.
 */
const tokens = (lines: string[]): number => lines.reduce((n, l) => n + (l.match(ASSERT)?.length ?? 0), 0);

/**
 * `declared` are files the approved plan or the gate commands name as tests (e.g. `check.js`); they are judged like
 * conventionally named test files, so a repo's unusual test layout cannot hide weakening.
 */
export function analyzeTestDiff(diff: string, declared: readonly string[] = []): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  for (const section of diff.split(/^diff --git /m).slice(1)) {
    const file = /^a\/(.+?) b\//.exec(section)?.[1];
    if (file && (HARNESS_FILE.test(file) || (/(^|\/)package\.json$/.test(file) && section.split('\n').some((l) => SCRIPT_LINE.test(l))))) findings.push({ file, kind: 'harness-changed', detail: 'test runner configuration or scripts changed' });
    if (!file || !(isTestFile(file) || declared.includes(file))) continue;
    if (/^deleted file mode/m.test(section)) {
      findings.push({ file, kind: 'test-deleted', detail: 'test file deleted' });
      continue;
    }
    const added = section.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    const removed = section.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    const a = tokens(added);
    const r = tokens(removed);
    if (r > a) findings.push({ file, kind: 'assertions-removed', detail: `${r} assertion tokens removed, ${a} added` });
    const skipped = added.filter((l) => SKIP.test(l)).length - removed.filter((l) => SKIP.test(l)).length;
    if (skipped > 0) findings.push({ file, kind: 'test-skipped', detail: `${skipped} skip/only marker(s) added` });
  }
  return findings;
}
