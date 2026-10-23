import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT, runCli, type CliEnv } from '../src/cli/index';
import { bugsOf, renderTestMarkdown, verdictOf } from '../src/engine/testrun';
import { Git } from '../src/git/git';
import { agents, project } from './engine-helpers';

function harness(root: string) {
  const out: string[] = [];
  const env: CliEnv = { cwd: root, env: {}, makeRuntime: () => agents(), io: { out: (t) => void out.push(t), err: () => undefined, stdin: () => '', isTTY: false, confirm: () => false } };
  return { env, text: () => out.join('') };
}

const ok = 'node -e 0';
const failing = 'node -e process.exit(1)';

describe('verdicts', () => {
  it('classifies a result against the base branch', () => {
    expect(verdictOf('PASS', 'PASS', 'x')).toBe('pass');
    expect(verdictOf('PASS', 'FAIL', 'x')).toBe('fixed');
    expect(verdictOf('FAIL', 'PASS', 'x')).toBe('regression');
    expect(verdictOf('FAIL', 'FAIL', 'x')).toBe('pre-existing');
    expect(verdictOf('FAIL', null, 'x')).toBe('fail');
    expect(verdictOf('BLOCKED', null, null)).toBe('gap');
    expect(verdictOf('BLOCKED', null, 'x')).toBe('fail');
  });

  it('turns failures into bugs and never a gap or a pass', () => {
    const row = (gateId: string, verdict: Parameters<typeof renderTestMarkdown>[0]['rows'][number]['verdict']) => ({ gateId, kind: gateId, command: 'c', state: 'FAIL', baseline: 'PASS', verdict, category: null });
    const bugs = bugsOf([row('unit', 'regression'), row('browser', 'gap'), row('lint', 'pass')], 'a'.repeat(40));
    expect(bugs.map((b) => b.key)).toEqual(['test:unit:regression']);
    expect(bugs[0]!.title).toContain('Regression');
  });
});

describe('proofloop test (project)', () => {
  it('passes a healthy project but reports a missing browser check as a gap, not a pass', async () => {
    const root = await project({ scripts: { lint: ok, typecheck: ok, test: ok, build: ok } });
    const h = harness(root);
    expect(await runCli(['test', '--no-baseline'], h.env)).toBe(EXIT.blocked);
    expect(h.text()).toMatch(/gap\s+browser/);
    expect(h.text()).toContain('required: this blocks a pass');
  });

  it('flags a check that passed on the base branch and fails on the branch as a regression, and writes the report', async () => {
    const root = await project({ scripts: { lint: ok, typecheck: ok, test: ok, build: ok } });
    const git = new Git();
    await git.run(root, ['checkout', '-q', '-b', 'feature/x']);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    pkg.scripts.test = failing;
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    await git.run(root, ['commit', '-qam', 'break unit']);
    const h = harness(root);
    expect(await runCli(['test', 'unit'], h.env)).toBe(EXIT.blocked);
    expect(h.text()).toMatch(/FAIL unit\s+FAIL\s+base:PASS\s+regression/);
    const dir = /report: (.*)report\.md/.exec(h.text())![1]!;
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('**regression**');
    const json = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    expect(json.bugs[0].key).toBe('test:unit:regression');
    expect(h.text()).toContain('unit failure (tail)');
    expect((await git.run(root, ['worktree', 'list'])).split('\n').length).toBe(1);
  }, 120_000);

  it('refuses a dirty tree', async () => {
    const root = await project({ scripts: { test: ok } });
    writeFileSync(join(root, 'x.txt'), 'x');
    expect(await runCli(['test'], harness(root).env)).toBe(EXIT.error);
  });
});
