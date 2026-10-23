import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../config';
import { runOn, stateOf } from '../engine/testrun';
import { type EngineDeps, clockOf, gateCtx } from '../engine/deps';
import { excludeStateDir } from '../engine/steps-plan';
import { ENGINE_VERSION } from '../version';
import { renderChecklist } from './checklist';
import { type Capacity, DEFAULT_TARGETS, type Targets, capacityModel } from './capacity';
import { type PathResult, probe } from './probe';
import { type ScanFinding, scanScalability } from './scan';

export type AuditStatus = 'measured-ok' | 'violations' | 'needs-review' | 'not-measured';

export interface AuditReport {
  engine: string; head: string; users: number; targets: Targets; capacity: Capacity;
  findings: ScanFinding[];
  probe: { measured: boolean; reason: string | null; concurrency: number; results: PathResult[]; violations: string[] };
  load: { state: string; command: string | null };
  status: AuditStatus; checklist: string; limitations: string[]; dir: string;
}

export function violationsOf(results: readonly PathResult[], t: Targets): string[] {
  return results.flatMap((r) => [
    ...(r.p95 > t.p95Ms ? [`${r.path}: p95 ${r.p95} ms exceeds ${t.p95Ms} ms`] : []),
    ...(r.p99 > t.p99Ms ? [`${r.path}: p99 ${r.p99} ms exceeds ${t.p99Ms} ms`] : []),
    ...(r.errorRate > t.errorRate ? [`${r.path}: error rate ${(r.errorRate * 100).toFixed(1)}% exceeds ${(t.errorRate * 100).toFixed(1)}%`] : []),
  ]);
}

/** Never "ok" unless something was actually measured and met its targets. */
export function statusOf(a: { measured: boolean; violations: number; loadState: string; highFindings: number }): AuditStatus {
  if (a.violations > 0 || a.loadState === 'FAIL') return 'violations';
  if (!a.measured) return 'not-measured';
  return a.highFindings > 0 ? 'needs-review' : 'measured-ok';
}

export function renderAuditMarkdown(r: AuditReport): string {
  const c = r.capacity;
  const L = ['# ProofLoop audit', '', `Engine ${r.engine} · commit \`${r.head.slice(0, 12)}\` · target scale **${r.users} users**`, '', `**Status: ${r.status}**`, '', '## Targets', '', `p95 <= ${r.targets.p95Ms} ms · p99 <= ${r.targets.p99Ms} ms · error rate <= ${(r.targets.errorRate * 100).toFixed(1)}%`, '', '## Capacity model (assumptions, not measurements)', '', `${c.concurrentUsers} concurrent users · ~${c.avgRps} rps average · ~${c.peakRps} rps peak · ~${c.inFlight} requests in flight at p95`, '', ...c.assumptions.map((x) => `- ${x}`), '', '## Measured', ''];
  if (r.probe.measured) L.push(`Synthetic probe, ${r.probe.concurrency} concurrent connections, one machine:`, '', '| Path | Requests | p50 | p95 | p99 | Errors | rps |', '|---|---|---|---|---|---|---|', ...r.probe.results.map((x) => `| ${x.path} | ${x.n} | ${x.p50} ms | ${x.p95} ms | ${x.p99} ms | ${x.errors} | ${x.rps} |`), '', ...(r.probe.violations.length ? r.probe.violations.map((v) => `- **violation:** ${v}`) : ['All probed paths met the targets.']));
  else L.push(`**Not measured:** ${r.probe.reason}`);
  L.push('', `Load test command: ${r.load.command ? `\`${r.load.command}\` -> ${r.load.state}` : 'none detected (set commands.load or add a test:load script, e.g. k6)'}`, '', '## Static scalability findings (heuristics, review each)', '');
  L.push(...(r.findings.length ? r.findings.map((f) => `- [${f.severity}] ${f.rule} \`${f.file}:${f.line}\` - ${f.why}\n  \`${f.text}\``) : ['None found by the heuristics.']));
  L.push('', '## System-design review checklist (answer each with file:line evidence)', '', r.checklist, '', '## Limits', '', ...r.limitations.map((x) => `- ${x}`), '');
  return L.join('\n');
}

export interface AuditOptions { users: number; targets?: Partial<Targets>; paths?: string[]; requests?: number; concurrency?: number; cwd?: string }

export async function runAudit(d: EngineDeps, o: AuditOptions): Promise<AuditReport> {
  const cwd = o.cwd ?? d.root;
  excludeStateDir(d.root);
  const head = await d.git.head(cwd);
  const targets = { ...DEFAULT_TARGETS, ...o.targets };
  const capacity = capacityModel(o.users, targets.p95Ms);
  const files = (await d.git.run(cwd, ['ls-files'])).split('\n').filter(Boolean);
  const findings = scanScalability(cwd, files);
  const { runId, plan } = await runOn(d, cwd, head, `audit ${head.slice(0, 12)} for ${o.users} users`, ['load'], 'performance');
  const load = { state: stateOf(d, runId, 'load').state, command: plan.find((e) => e.gateId === 'load')?.command ?? null };
  const concurrency = o.concurrency ?? Math.min(100, Math.max(8, capacity.inFlight));
  const results: PathResult[] = [];
  let reason: string | null = null;
  const startApp = gateCtx(d, runId, cwd, head).startApp;
  if (!startApp) reason = 'no app start command and URL configured (app.start, app.url in .proofloop/config.json), so p95/p99 were not measured';
  else {
    const app = await startApp().catch((e: unknown) => ((reason = `the app did not start: ${e instanceof Error ? e.message : String(e)}`), null));
    if (app) {
      try {
        results.push(...(await probe({ baseUrl: app.url, paths: o.paths?.length ? o.paths : ['/'], concurrency, requests: o.requests ?? 300 })));
      } finally {
        await app.stop();
      }
    }
  }
  const violations = violationsOf(results, targets);
  const measured = results.length > 0 || load.state === 'PASS';
  const status = statusOf({ measured, violations: violations.length, loadState: load.state, highFindings: findings.filter((f) => f.severity === 'high').length });
  const dir = join(stateDir(d.root), 'audits', clockOf(d).nowIso().replace(/[:.]/g, '-'));
  const report: AuditReport = {
    engine: ENGINE_VERSION, head, users: o.users, targets, capacity, findings, probe: { measured: results.length > 0, reason, concurrency, results, violations }, load, status, checklist: renderChecklist(), dir,
    limitations: [
      `The probe is one machine hitting the listed paths with ${concurrency} connections. It does not simulate ${o.users} real users, a production database size, network latency or other instances. A pass means "met the targets in this probe", never "will handle ${o.users} users".`,
      'The capacity figures are assumptions printed above; change them with real traffic data when you have it.',
      'Static findings are line-based heuristics: they can miss problems and can flag safe code. The design checklist needs a reviewer who reads the code and cites evidence.',
      'Index and query-plan checks need a database; use the performance protocol with a query-plan adapter for those.',
    ],
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, 'report.md'), renderAuditMarkdown(report));
  return report;
}
