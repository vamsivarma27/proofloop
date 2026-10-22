import { describe, expect, it } from 'vitest';
import { SequentialToolComposer } from '../src/composer/sequential';
import { toolComposerContract } from '../src/sdk/contracts';
import { initRepo } from './repo-helpers';

const make = async () => new SequentialToolComposer({ root: await initRepo({ 'src/a.ts': 'export const a = 1;\n', '.env': 'S=1' }) });

describe('SequentialToolComposer (no sandbox, no network)', () => {
  it('runs a JSON list of tool calls and returns every result', async () => {
    const c = await make();
    const r = await c.run(JSON.stringify([{ tool: 'tests.discoverSuites', args: {} }, { tool: 'tests.discoverSuites', args: {} }]));
    expect(r.ok).toBe(true);
    expect((r.value as unknown[]).length).toBe(2);
    expect(r.calls.map((x) => x.ok)).toEqual([true, true]);
  });

  it('rejects code: nothing the model writes is executed', async () => {
    const r = await (await make()).run('return 1');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('program rejected');
    expect(r.calls).toHaveLength(0);
  });

  it('applies host rules: unknown tools, write authorization, call limit', async () => {
    const c = await make();
    expect((await c.run('[{"tool":"nope.x","args":{}}]')).error).toContain('unknown tool');
    expect((await c.run('[{"tool":"github.addCheckpoint","args":{}}]')).error).toContain('not authorized');
    const many = JSON.stringify(Array.from({ length: 3 }, () => ({ tool: 'tests.discoverSuites', args: {} })));
    expect((await c.run(many, { limits: { maxCalls: 2 } })).error).toContain('call limit');
  });

  it('honours cancellation and satisfies the ToolComposer contract', async () => {
    const c = await make();
    const ac = new AbortController();
    ac.abort();
    expect((await c.run('[{"tool":"tests.discoverSuites","args":{}}]', { signal: ac.signal })).error).toBe('cancelled');
    await toolComposerContract(() => c, { ok: (v, m) => expect(v, m).toBeTruthy(), equal: (x, y, m) => expect(x, m).toEqual(y) });
  });
});
