import { describe, expect, it } from 'vitest';
import { ALWAYS_DENIED, ClaudeCodeRuntime, ROLE_TOOLS, parseResult, parseVersion, versionAtLeast } from '../src/agent/runtime';
import type { Exec, ExecResult } from '../src/shared/exec';

const res = (over: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, truncated: false, ...over });
const base = { runId: 'run_1', prompt: 'plan it', cwd: '/tmp', maxBudgetUsd: 1.5, timeoutMs: 1000 };

describe('ClaudeCodeRuntime uses only documented, permission-preserving flags (v0.1 AC8)', () => {
  it('never disables permission controls and never grants evaluators edit tools', () => {
    const rt = new ClaudeCodeRuntime({ guardCommand: '/x/bin/proofloop' });
    for (const role of ['planner', 'implementer', 'reviewer', 'security-reviewer', 'evidence-evaluator'] as const) {
      const args = rt.buildArgs({ ...base, role });
      const joined = args.join(' ');
      expect(joined).not.toMatch(/dangerously|bypassPermissions|skip-permissions/);
      expect(args).toContain('--permission-prompts');
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
      expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('1.5');
      expect(args[args.indexOf('--disallowedTools') + 1]).toBe(ALWAYS_DENIED.join(','));
      const allowed = args[args.indexOf('--allowedTools') + 1]!.split(',');
      if (role !== 'implementer') expect(allowed.some((t) => /^(Edit|Write|MultiEdit)$/.test(t))).toBe(false);
    }
    expect(ROLE_TOOLS.reviewer).not.toContain('Edit');
  });

  it('only the implementer resumes sessions; evaluators always get fresh context', () => {
    const rt = new ClaudeCodeRuntime();
    expect(rt.buildArgs({ ...base, role: 'implementer', resumeSessionId: 'abc' })).toEqual(expect.arrayContaining(['--resume', 'abc']));
    expect(rt.buildArgs({ ...base, role: 'reviewer', resumeSessionId: 'abc' })).not.toContain('--resume');
  });

  it('passes the JSON schema and a fail-closed PreToolUse hook through --settings', () => {
    const args = new ClaudeCodeRuntime({ guardCommand: '/x/bin/proofloop' }).buildArgs({ ...base, role: 'planner', jsonSchema: { type: 'object' } });
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('hook pre-tool-use');
  });

  it('runs with a scrubbed environment plus the agent marker and no ambient tokens', async () => {
    let seen: Record<string, string> | undefined;
    const exec: Exec = async (_c, _a, o) => { seen = o?.env; return res({ stdout: JSON.stringify({ result: 'ok', session_id: 's1', total_cost_usd: 0.02 }) }); };
    process.env.GH_TOKEN = 'should-not-leak';
    try {
      const r = await new ClaudeCodeRuntime({ exec }).run({ ...base, role: 'implementer' });
      expect(r).toMatchObject({ ok: true, sessionId: 's1', costUsd: 0.02 });
    } finally {
      delete process.env.GH_TOKEN;
    }
    expect(seen).toMatchObject({ PROOFLOOP_AGENT_SESSION: '1', PROOFLOOP_ROLE: 'implementer', PROOFLOOP_RUN_ID: 'run_1' });
    expect(seen).not.toHaveProperty('GH_TOKEN');
  });

  it('reports failures as results, never throws, and redacts secrets', async () => {
    const mk = (r: ExecResult) => new ClaudeCodeRuntime({ exec: async () => r }).run({ ...base, role: 'planner' });
    expect((await mk(res({ spawnError: 'ENOENT', code: null }))).error).toContain('could not start');
    expect((await mk(res({ timedOut: true, code: null }))).error).toContain('timed out');
    expect((await mk(res({ stdout: 'not json', code: 1 }))).ok).toBe(false);
    const leak = await mk(res({ stdout: JSON.stringify({ is_error: true, result: `failed with Bearer ${'a'.repeat(30)}`, permission_denials: [{ tool: 'Bash' }] }) }));
    expect(leak.ok).toBe(false);
    expect(leak.error).not.toContain('aaaaaaaaaa');
    expect(leak.permissionDenials.length).toBe(1);
    expect(parseResult(JSON.stringify({ result: 'x', structured_output: { a: 1 } }), 0).structured).toEqual({ a: 1 });
  });

  it('checks the Claude Code version against the documented minimum', async () => {
    const v = (out: string, spawnError?: string) => new ClaudeCodeRuntime({ exec: async () => res({ stdout: out, ...(spawnError ? { spawnError, code: null } : {}) }) }).checkVersion();
    expect(await v('2.1.308 (Claude Code)')).toMatchObject({ ok: true, version: '2.1.308' });
    expect(await v('2.1.200')).toMatchObject({ ok: false, problem: expect.stringContaining('>= 2.1.259') });
    expect((await v('', 'ENOENT')).problem).toContain('not found');
    expect((await v('garbage')).ok).toBe(false);
    expect(parseVersion('v3.0.1')).toEqual([3, 0, 1]);
    expect(versionAtLeast([2, 1, 259], [2, 1, 259])).toBe(true);
    expect(versionAtLeast([2, 0, 999], [2, 1, 0])).toBe(false);
  });
});
