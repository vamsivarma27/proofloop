import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capacityModel } from '../src/audit/capacity';
import { DESIGN_CHECKLIST, renderChecklist } from '../src/audit/checklist';
import { probe } from '../src/audit/probe';
import { scanScalability } from '../src/audit/scan';
import { renderAuditMarkdown, statusOf, violationsOf } from '../src/audit/audit';
import { EXIT, runCli, type CliEnv } from '../src/cli/index';
import { validatePlan } from '../src/plan/schema';
import { plannerPrompt } from '../src/engine/prompts';
import { tmp } from './repo-helpers';
import { agents, featurePlan, project } from './engine-helpers';

describe('capacity model', () => {
  it('derives rps and in-flight requests from users with printed assumptions', () => {
    const c = capacityModel(2000, 300);
    expect(c).toMatchObject({ concurrentUsers: 200, avgRps: 20, peakRps: 60, inFlight: 18 });
    expect(c.assumptions.join(' ')).toContain('Little');
  });
});

describe('verdicts', () => {
  const r = (over: object) => ({ path: '/', n: 100, errors: 0, errorRate: 0, p50: 5, p95: 20, p99: 40, rps: 100, ...over });
  const t = { p95Ms: 300, p99Ms: 800, errorRate: 0.01 };
  it('flags p95, p99 and error-rate violations per path', () => {
    expect(violationsOf([r({})], t)).toEqual([]);
    expect(violationsOf([r({ p95: 400, p99: 900, errorRate: 0.05 })], t)).toHaveLength(3);
  });
  it('is never ok unless something was measured and met', () => {
    expect(statusOf({ measured: false, violations: 0, loadState: 'BLOCKED', highFindings: 0 })).toBe('not-measured');
    expect(statusOf({ measured: true, violations: 0, loadState: 'BLOCKED', highFindings: 0 })).toBe('measured-ok');
    expect(statusOf({ measured: true, violations: 0, loadState: 'PASS', highFindings: 2 })).toBe('needs-review');
    expect(statusOf({ measured: true, violations: 1, loadState: 'PASS', highFindings: 0 })).toBe('violations');
    expect(statusOf({ measured: true, violations: 0, loadState: 'FAIL', highFindings: 0 })).toBe('violations');
  });
});

describe('static scan', () => {
  it('finds unbounded queries, N+1, missing timeouts, sync io and unbounded in-process state, and skips tests', () => {
    const root = tmp();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/api.js'), ["const cache = new Map();", "const rows = db.query('SELECT * FROM users');", 'for (const u of users) {', '  const o = await db.query(u.id);', '}', "const r = await fetch('https://x.example/api');", "const f = readFileSync('a');", "const ok = db.query('SELECT * FROM users LIMIT 10');", ''].join('\n'));
    writeFileSync(join(root, 'src/api.test.js'), "db.query('SELECT * FROM users');");
    const rules = scanScalability(root, ['src/api.js', 'src/api.test.js']).map((f) => f.rule).sort();
    expect(rules).toEqual(['n-plus-one', 'no-timeout', 'process-local-state', 'sync-io', 'unbounded-query']);
  });
});

describe('probe', () => {
  it('measures percentiles and counts server errors against a real server', async () => {
    const srv = createServer((q, s) => { s.statusCode = q.url === '/bad' ? 500 : 200; s.end('ok'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const out = await probe({ baseUrl: `http://127.0.0.1:${port}`, paths: ['/', '/bad'], concurrency: 5, requests: 40, warmup: 2 });
      expect(out[0]).toMatchObject({ path: '/', n: 40, errors: 0 });
      expect(out[0]!.p99).toBeGreaterThanOrEqual(out[0]!.p95);
      expect(out[1]).toMatchObject({ path: '/bad', errors: 40, errorRate: 1 });
    } finally {
      srv.close();
    }
  });
});

describe('proofloop audit (cli)', () => {
  const harness = (root: string) => {
    const out: string[] = [];
    const env: CliEnv = { cwd: root, env: {}, makeRuntime: () => agents(), io: { out: (t) => void out.push(t), err: () => undefined, stdin: () => '', isTTY: false, confirm: () => false } };
    return { env, text: () => out.join('') };
  };

  it('says not-measured, never ok, when the app cannot be started', async () => {
    const root = await project({ scripts: { test: 'node -e 0' } });
    const h = harness(root);
    expect(await runCli(['audit', '--users', '500'], h.env)).toBe(EXIT.blocked);
    expect(h.text()).toContain('not-measured');
    expect(h.text()).toContain('not measured: no app start');
  });

  it('prints the checklist and rejects bad numbers', async () => {
    const root = await project();
    const h = harness(root);
    expect(await runCli(['audit', '--checklist'], h.env)).toBe(EXIT.ok);
    expect(h.text()).toContain('resilience');
    expect(await runCli(['audit', '--users', 'abc'], harness(root).env)).toBe(EXIT.usage);
  });

  it('renders the report with the limits and checklist', () => {
    const md = renderAuditMarkdown({ engine: 'x', head: 'a'.repeat(40), users: 2000, targets: { p95Ms: 300, p99Ms: 800, errorRate: 0.01 }, capacity: capacityModel(2000, 300), findings: [], probe: { measured: false, reason: 'none', concurrency: 8, results: [], violations: [] }, load: { state: 'BLOCKED', command: null }, status: 'not-measured', checklist: renderChecklist(), limitations: ['l'], dir: 'd' });
    expect(md).toContain('Not measured');
    expect(md).toContain('Capacity model');
    expect(DESIGN_CHECKLIST.length).toBe(8);
  });
});

describe('plan design section', () => {
  const base = featurePlan();
  const design = { scale: { expectedUsers: 2000, targets: { p95Ms: 300, p99Ms: 800, errorRate: 0.01 } }, decisions: [{ area: 'data-access', decision: 'paginate with a keyset cursor and index created_at' }] };
  it('requires a load or performance check when a scale is stated', () => {
    expect(validatePlan({ ...base, design }).errors.join()).toContain('no load/performance check');
    const ok = validatePlan({ ...base, design, testPlan: [...base.testPlan, { id: 'T-load', kind: 'load', description: 'k6 at 60 rps', gateId: 'load' }] });
    expect(ok.errors).toEqual([]);
  });
  it('warns when a medium-risk plan has no design section', () => {
    const v = validatePlan({ ...base, risk: { level: 'high', rationale: 'touches payments paths' } });
    expect(v.warnings.join()).toContain('no design section');
  });
  it('puts the checklist in the planner prompt', () => {
    const p = plannerPrompt({ protocol: { id: 'feature', title: 'Feature', requiredArtifacts: [] } as never, intent: 'x', detected: { languages: [], packageManager: null, commands: {}, ci: [], limitations: [] } as never, files: [] });
    expect(p).toContain('design.scale');
    expect(p).toContain('resilience');
  });
});
