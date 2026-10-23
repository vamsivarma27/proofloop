import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT, runCli, type CliEnv } from '../src/cli/index';
import { evaluateHook, hookOutput } from '../src/cli/hook';
import { agents, project } from './engine-helpers';
import { tmp } from './repo-helpers';

function harness(root: string, over: { env?: NodeJS.ProcessEnv; tty?: boolean; answer?: boolean; stdin?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const rt = agents();
  const env: CliEnv = {
    cwd: root,
    env: over.env ?? {},
    makeRuntime: () => rt,
    io: { out: (t) => void out.push(t), err: (t) => void err.push(t), stdin: () => over.stdin ?? '', isTTY: over.tty ?? false, confirm: () => over.answer ?? false },
  };
  return { env, out, err, rt, text: () => out.join(''), errText: () => err.join('') };
}

const idFrom = (text: string): string => /run (run_[0-9a-f]+)/.exec(text)![1]!;

describe('cli flow', () => {
  it('feature -> approve (human) -> run -> status -> report', async () => {
    const root = await project();
    const h = harness(root);
    expect(await runCli(['feature', 'Add the feature file'], h.env)).toBe(EXIT.ok);
    const id = idFrom(h.text());
    expect(h.text()).toContain('AWAITING_APPROVAL');

    // without a hash it only shows the plan
    const show = harness(root);
    expect(await runCli(['approve', id], show.env)).toBe(EXIT.ok);
    expect(show.text()).toContain('Not approved');
    const hash = /--plan-hash (\w+)/.exec(show.text())![1]!;

    // non-interactive approval without --yes is refused
    const refused = harness(root);
    expect(await runCli(['approve', id, '--plan-hash', hash], refused.env)).toBe(EXIT.refused);

    // an agent session can never approve, even with --yes
    const agent = harness(root, { env: { PROOFLOOP_AGENT_SESSION: '1' } });
    expect(await runCli(['approve', id, '--plan-hash', hash, '--yes'], agent.env)).toBe(EXIT.refused);

    // wrong hash is refused by the store
    const wrong = harness(root);
    expect(await runCli(['approve', id, '--plan-hash', 'deadbeef', '--yes'], wrong.env)).toBe(EXIT.error);

    const ok = harness(root);
    expect(await runCli(['approve', id, '--plan-hash', hash, '--yes'], ok.env)).toBe(EXIT.ok);

    const run = harness(root);
    expect(await runCli(['run', id], run.env)).toBe(EXIT.ok);
    expect(run.text()).toContain('PR_OPEN');

    const st = harness(root);
    await runCli(['status', id], st.env);
    expect(st.text()).toMatch(/unit: PASS/);
    const rep = harness(root);
    await runCli(['report', id], rep.env);
    expect(existsSync(join(root, '.proofloop', 'reports', `${id}.md`))).toBe(true);
    expect(readFileSync(join(root, '.proofloop', 'reports', `${id}.md`), 'utf8')).toContain('All required gates PASS');
    const list = harness(root);
    await runCli(['status', '--json'], list.env);
    expect(JSON.parse(list.text())[0].state).toBe('PR_OPEN');
  });

  it('interactive approval asks a human; declining refuses', async () => {
    const root = await project();
    const h = harness(root);
    await runCli(['feature', 'Add the feature file'], h.env);
    const id = idFrom(h.text());
    const hash = (await import('../src/state/db')).openDb(join(root, '.proofloop', 'state.db')).prepare('select current_plan_hash h from task_run').get() as { h: string };
    const no = harness(root, { tty: true, answer: false });
    expect(await runCli(['approve', id, '--plan-hash', hash.h], no.env)).toBe(EXIT.refused);
    const yes = harness(root, { tty: true, answer: true });
    expect(await runCli(['approve', id, '--plan-hash', hash.h], yes.env)).toBe(EXIT.ok);
  });

  it('reject returns to planning; cancel and pause work; usage errors exit 2', async () => {
    const root = await project();
    const h = harness(root);
    await runCli(['feature', 'Add the feature file'], h.env);
    const id = idFrom(h.text());
    const rej = harness(root);
    expect(await runCli(['reject', id, '--comment', 'too broad'], rej.env)).toBe(EXIT.ok);
    expect(await runCli(['pause', id], harness(root).env)).toBe(EXIT.ok);
    const c = harness(root);
    expect(await runCli(['cancel', id], c.env)).toBe(EXIT.ok);
    expect(c.text()).toContain('CANCELLED');
    expect(await runCli(['feature'], harness(root).env)).toBe(EXIT.usage);
    expect(await runCli(['run'], harness(root).env)).toBe(EXIT.usage);
    expect(await runCli(['nonsense'], harness(root).env)).toBe(EXIT.usage);
    expect(await runCli(['help'], harness(root).env)).toBe(EXIT.ok);
  });

  it('plan submit validates and records a plan from stdin', async () => {
    const root = await project();
    const h = harness(root);
    await runCli(['feature', 'Add the feature file'], h.env);
    const id = idFrom(h.text());
    const bad = harness(root, { stdin: '{"nope":1}' });
    expect(await runCli(['plan', 'submit', id], bad.env)).toBe(EXIT.error);
    expect(bad.errText()).toContain('plan rejected');
    const show = harness(root);
    expect(await runCli(['plan', 'show', id], show.env)).toBe(EXIT.ok);
    expect(show.text()).toContain('Acceptance criteria');
  });

  it('verify reports evidence for the current commit and fails when nothing is verifiable', async () => {
    const root = await project({ scripts: { lint: 'node -e 0', typecheck: 'node -e 0', test: 'node -e 0', build: 'node -e 0' } });
    const h = harness(root);
    expect(await runCli(['verify'], h.env)).toBe(EXIT.ok);
    expect(h.text()).toMatch(/unit \| yes \| PASS/);
    const none = await project({ scripts: {} });
    const n = harness(none);
    expect(await runCli(['verify'], n.env)).toBe(EXIT.blocked);
    writeFileSync(join(root, 'dirty.txt'), 'x');
    const d = harness(root);
    expect(await runCli(['verify'], d.env)).toBe(EXIT.error);
    expect(d.errText()).toContain('uncommitted');
  });

  it('protocols, protocol validate and setup', async () => {
    const root = await project();
    const p = harness(root);
    expect(await runCli(['protocols'], p.env)).toBe(EXIT.ok);
    expect(p.text()).toContain('feature');
    const dir = tmp();
    const bad = join(dir, 'bad.yaml');
    writeFileSync(bad, 'id: Bad_ID\nversion: 1\n');
    const v = harness(root);
    expect(await runCli(['protocol', 'validate', bad], v.env)).toBe(EXIT.error);
    expect(v.errText()).toContain('id');
    const good = harness(root);
    expect(await runCli(['protocol', 'validate', join(process.cwd(), 'protocols', 'feature.yaml')], good.env)).toBe(EXIT.ok);
    const s = harness(root);
    await runCli(['setup'], s.env);
    expect(s.text()).toContain('self-check');
    expect(existsSync(join(root, '.proofloop', 'config.json'))).toBe(false);
    await runCli(['setup', '--yes'], harness(root).env);
    expect(existsSync(join(root, '.proofloop', 'config.json'))).toBe(true);
  });
});

describe('PreToolUse guard (deterministic)', () => {
  const agent = { PROOFLOOP_AGENT_SESSION: '1' };
  const bash = (command: string, env: NodeJS.ProcessEnv = {}) => evaluateHook({ tool_name: 'Bash', tool_input: { command }, cwd: process.cwd() }, env);

  it('denies agent sessions any state-changing proofloop command', () => {
    for (const c of ['proofloop approve run_1 --yes', 'proofloop reject run_1', 'proofloop gates run', 'proofloop cancel run_1', '/x/bin/proofloop resume run_1'])
      expect(bash(c, agent).decision, c).toBe('deny');
  });

  it('asks a human before approve/reject in interactive sessions, allows read-only status', () => {
    expect(bash('proofloop approve run_1 --plan-hash abc --yes').decision).toBe('ask');
    expect(bash('proofloop status').decision).toBe('allow');
    expect(bash('proofloop report run_1').decision).toBe('allow');
  });

  it('denies critical/destructive shell for agents and asks interactively', () => {
    expect(bash('rm -rf /', agent).decision).toBe('deny');
    expect(bash('kubectl delete ns prod', agent).decision).toBe('deny');
    expect(bash('git push --force', {}).decision).toBe('ask');
    expect(bash('pnpm test', agent).decision).toBe('allow');
  });

  it('judges the command that is run, not words in a grep pattern or path (false prompt reported by a user)', () => {
    const grep = 'cd ~/.claude/plugins/cache/proofloop/proofloop/1.0.0-rc.2 && grep -rn "harnessApproved\\|approvedHarness" src';
    expect(bash(grep, {}).decision).toBe('allow');
    expect(bash(grep, agent).decision).toBe('allow');
    expect(bash('proofloop approve run_1', {}).decision).toBe('ask');
    expect(bash('cd x && proofloop approve run_1', agent).decision).toBe('deny');
    expect(bash('bash -c "proofloop approve run_1"', agent).decision).toBe('deny');
    expect(bash('FOO=1 ./bin/proofloop --json reject run_1', agent).decision).toBe('deny');
  });

  it('denies writes to protected paths and reads of secrets, allows normal edits', () => {
    const cwd = tmp();
    const w = (file_path: string, tool_name = 'Write') => evaluateHook({ tool_name, tool_input: { file_path }, cwd }, {});
    expect(w('.env').decision).toBe('deny');
    expect(w('.git/hooks/pre-commit', 'Edit').decision).toBe('deny');
    expect(w('../outside.txt').decision).toBe('deny');
    expect(w('src/ok.ts').decision).toBe('allow');
    expect(w('.env', 'Read').decision).toBe('deny');
  });

  it('emits Claude Code hook JSON only for non-allow decisions and fails closed on bad input', async () => {
    expect(hookOutput({ decision: 'allow', reason: '' })).toBe('');
    expect(JSON.parse(hookOutput({ decision: 'deny', reason: 'no' })).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    const root = await project();
    const bad = harness(root, { stdin: 'not json' });
    expect(await runCli(['hook', 'pre-tool-use'], bad.env)).toBe(2);
    const good = harness(root, { stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'proofloop approve x' }, cwd: root }), env: agent });
    expect(await runCli(['hook', 'pre-tool-use'], good.env)).toBe(0);
    expect(JSON.parse(good.text()).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await runCli(['hook', 'bogus'], harness(root).env)).toBe(EXIT.usage);
  });
});

describe('launcher', () => {
  it('works when npm links it into node_modules/.bin (symlinked)', async () => {
    const { symlinkSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const link = join(tmp(), 'proofloop-link');
    symlinkSync(join(process.cwd(), 'bin', 'proofloop'), link);
    expect(execFileSync(link, ['--help'], { encoding: 'utf8' })).toContain('proofloop');
  });
});

describe('proofloop test command', () => {
  it('lists suites', async () => {
    const h = harness(tmp());
    expect(await runCli(['test', '--list'], h.env)).toBe(0);
    expect(h.text()).toContain('recovery');
  });
});

describe('prompt hook: a bare test request starts the testing protocol', () => {
  it('matches test requests only, and names the suites', async () => {
    const { testRequest, promptHookOutput } = await import('../src/cli/hook');
    for (const p of ['test', 'Test!', 'run all tests', 'please run the tests', 'proofloop test everything']) expect(testRequest(p), p).toEqual([]);
    expect(testRequest('test bug and recovery')).toEqual(['bug', 'recovery']);
    for (const p of ['test the login page', 'fix the failing test in auth', 'add a feature', '']) expect(testRequest(p), p).toBeNull();
    expect(JSON.parse(promptHookOutput('test bug')).hookSpecificOutput.additionalContext).toContain('bug suite');
    expect(promptHookOutput('hello')).toBe('');
  });

  it('is fail-open on unreadable input and wired in hooks.json', async () => {
    const h = harness(tmp(), { stdin: 'not json' });
    expect(await runCli(['hook', 'user-prompt'], h.env)).toBe(0);
    const ok = harness(tmp(), { stdin: JSON.stringify({ prompt: 'test' }) });
    expect(await runCli(['hook', 'user-prompt'], ok.env)).toBe(0);
    expect(ok.text()).toContain('UserPromptSubmit');
    const hooks = JSON.parse((await import('node:fs')).readFileSync('hooks/hooks.json', 'utf8'));
    expect(hooks.hooks.UserPromptSubmit[0].hooks[0].args).toEqual(['hook', 'user-prompt']);
  });
});
