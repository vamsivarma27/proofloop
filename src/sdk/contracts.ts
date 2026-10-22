import type { AgentRuntime } from '../agent/runtime';
import type { ToolComposer } from '../composer/types';
import type { GithubPort } from '../github/adapter';
import type { QueryPlanAdapter } from '../perf/queryplan';

/** Minimal assertion surface so adapter authors can run these under any test framework. */
export interface Assert {
  ok(value: unknown, message: string): void;
  equal(actual: unknown, expected: unknown, message: string): void;
}

/** A GithubPort must be idempotent per key and must report unsupported link mutations instead of throwing. */
export async function githubPortContract(make: () => GithubPort, a: Assert): Promise<void> {
  const port = make();
  const one = await port.ensureIssue('contract/1', 'Contract issue', 'body');
  const again = await port.ensureIssue('contract/1', 'Contract issue', 'different body');
  a.equal(again.number, one.number, 'ensureIssue returns the same issue for the same key');
  a.ok(one.nodeId.length > 0 && one.url.length > 0, 'issues carry a stable node id and url');
  const other = await port.ensureIssue('contract/2', 'Second', 'body');
  a.ok(other.number !== one.number, 'different keys create different issues');
  await port.addCheckpoint(one, 'contract/cp/1', 'checkpoint');
  await port.addCheckpoint(one, 'contract/cp/1', 'checkpoint');
  const link = await port.linkSubIssue(one, other);
  a.ok(link === 'linked' || link === 'unsupported', 'linkSubIssue returns linked|unsupported');
  const block = await port.blockedBy(other, one);
  a.ok(block === 'linked' || block === 'unsupported', 'blockedBy returns linked|unsupported');
}

/** A runtime must report failures as ok:false (never throw) and must not leak raw secrets in text. */
export async function agentRuntimeContract(make: () => AgentRuntime, a: Assert, cwd: string): Promise<void> {
  const rt = make();
  const res = await rt.run({ role: 'planner', runId: 'contract', prompt: 'say hello', cwd, maxBudgetUsd: 0.01, timeoutMs: 15_000 });
  a.ok(typeof res.ok === 'boolean' && typeof res.text === 'string' && Array.isArray(res.permissionDenials), 'result has ok, text and permissionDenials');
  a.ok(!/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(res.text), 'result text is redacted');
}

/** A composer must fail closed: bad programs and unavailable sandboxes return ok:false with a diagnostic. */
export async function toolComposerContract(make: () => ToolComposer, a: Assert): Promise<void> {
  const c = make();
  a.ok(typeof c.available().ok === 'boolean', 'available() reports a boolean');
  a.ok(Array.isArray(c.describeTools()), 'describeTools() returns an array');
  const bad = await c.run('this is not javascript (');
  a.equal(bad.ok, false, 'invalid programs do not succeed');
  a.ok(typeof bad.error === 'string' && bad.error.length > 0, 'failures carry a diagnostic');
  a.equal(bad.calls.length, 0, 'invalid programs make no tool calls');
  if (!c.available().ok) {
    const blocked = await c.run('return 1');
    a.equal(blocked.ok, false, 'an unavailable composer never runs the program');
  }
}

/** A query-plan adapter must refuse anything that is not a single read-only statement. */
export function queryPlanContract(make: () => QueryPlanAdapter, selectSql: string, a: Assert): void {
  const adapter = make();
  const [f] = adapter.inspect([selectSql]);
  a.ok(Boolean(f) && Array.isArray(f!.steps), 'inspect returns plan steps for a SELECT');
  let refused = false;
  try {
    adapter.inspect(['DELETE FROM x']);
  } catch {
    refused = true;
  }
  a.ok(refused, 'inspect refuses non-SELECT statements');
}
