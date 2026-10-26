import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ClaudeCodeRuntime, type AgentRuntime } from '../agent/runtime';
import { configPath, configSchema, writeConfig } from '../config';
import { createEngine } from '../engine/factory';
import { Git } from '../git/git';
import { approveGated, approvePlan, humanActor, rejectPlan } from '../plan/workflow';
import { detectRepo } from '../repo/detect';
import { loadRegistry, parseProtocol, pluginRoot } from '../protocol/registry';
import { PlError } from '../shared/errors';
import { nodeExec } from '../shared/exec';
import { FileLogger } from '../shared/log';
import { type DriveOutcome } from '../engine/engine';
import { ENGINE_VERSION } from '../version';
import { runComposerBench } from '../evals/composer-bench';
import { renderEvalMarkdown, runEvals } from '../evals/runner';
import { SUITES, runSuites } from '../evals/suites';
import { testCurrent } from '../engine/testrun';
import { runAudit } from '../audit/audit';
import { renderChecklist } from '../audit/checklist';
import { GhAdapter } from '../github/adapter';
import { renderRealMarkdown, runRealEvals } from '../evals/real';
import { addArtifact } from '../gates/artifacts';
import { fromK6Summary, sampleCount } from '../perf/report';
import { recordMeasurement } from '../perf/record';
import { renderReadiness } from '../engine/report';
import { TOPICS, type TopicId, fillDefaults, loadInterview, nextQuestion, recordAnswer } from '../blueprint/interview';
import { renderBlueprintMarkdown } from '../blueprint/render';
import { getBlueprint, submitBlueprint } from '../blueprint/workflow';
import { approvalRequest, approvedContext, evaluateHook, hookOutput, promptHookOutput } from './hook';
import { renderPlanMarkdown } from '../plan/schema';
import { getPlan } from '../plan/workflow';
import type { Plan } from '../plan/schema';
import { renderLedgerMarkdown } from '../ledger/ledger';
import { ledgerFor } from '../engine/ledger-io';
import { incidentsOf, repositoryIdOf, storedMemory } from '../engine/memory';
import { memoryForPrompt } from '../memory/retrieve';

export interface Io {
  out(text: string): void;
  err(text: string): void;
  stdin(): string;
  isTTY: boolean;
  confirm(question: string): boolean;
}

export interface CliEnv {
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: Io;
  makeRuntime?: (root: string) => AgentRuntime;
  /** tests replace the detached background run */
  startRun?: (root: string, runId: string, log: string) => void;
}

export const EXIT = { ok: 0, error: 1, usage: 2, refused: 3, blocked: 10, paused: 11 } as const;
const PROTOCOL_COMMANDS: Record<string, string> = { feature: 'feature', bug: 'bug', diagnose: 'troubleshooting', performance: 'performance', refactor: 'refactor', security: 'security' };
const HELP = `proofloop ${ENGINE_VERSION}

Task commands:  feature|bug|diagnose|performance|refactor|security "<request>" · start-project "<idea>"
Blueprint:      blueprint next-question|answer|defaults|submit|show <id>
Lifecycle:      status [id] · wait <id> [--timeout s] · approve <id> --plan-hash H [--scope S] · reject <id> --comment C · run <id> · resume <id> [--retry] · cancel <id> · pause <id>
Evidence:       verify · report <id> [--out file] · readiness <id> · plan show <id>
Memory:         ledger export <id> [--format json|markdown] [--out file] · memory <id> · incident list|show <id>|confirm <id> --text T --yes
Artifacts:      artifact add|list <id> [name --file f] · perf record|import-k6 <id> --file f
Evaluation:     eval [task-id-substring...] · eval composer · eval --runtime claude [--max-usd 1] [--total-usd 10] [--model m]  (real model; spends money)
Audit:          audit [--users 2000] [--p95 300] [--p99 800] [--error-rate 0.01] [--path /x ...] [--requests 300] · audit --checklist   (scale, latency percentiles, system-design review)
Testing:        test [gate...] [--no-baseline] [--file-bugs]  (full project test: all checks, browser personas, regression vs base)
                selftest [suite...|all] · selftest --list   (ProofLoop's own end-to-end suites)
Setup:          setup [--yes] [--github owner/repo] · protocols · protocol validate <file...>
Options:        --root <dir> · --json
`;

async function rootOf(c: CliEnv, flag?: string): Promise<string> {
  if (flag) return resolve(c.cwd, flag);
  const git = new Git();
  return (await git.isRepo(c.cwd)) ? await git.topLevel(c.cwd) : c.cwd;
}

const exitFor = (o: DriveOutcome): number => (o.state === 'BLOCKED' ? EXIT.blocked : o.state === 'PAUSED' ? EXIT.paused : EXIT.ok);

function show(c: CliEnv, json: boolean, value: unknown, text: string): void {
  c.io.out(json ? `${JSON.stringify(value, null, 2)}\n` : text);
}

function outcomeText(o: DriveOutcome, next: string): string {
  return `run ${o.runId}: ${o.state}${o.waiting ? ` (waiting: ${o.waiting})` : ''}${o.reason ? `\n  ${o.reason}` : ''}\n  next: ${next}\n`;
}

async function engineOf(c: CliEnv, root: string) {
  const runtime = c.makeRuntime?.(root) ?? new ClaudeCodeRuntime({ guardCommand: join(pluginRoot(), 'bin', 'proofloop') });
  const logFile = join(root, '.proofloop', 'logs', 'proofloop.log');
  return createEngine({ root, runtime, logger: new FileLogger(logFile) });
}

export async function runCli(argv: string[], c: CliEnv): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: { root: { type: 'string' }, json: { type: 'boolean' }, yes: { type: 'boolean' }, retry: { type: 'boolean' }, 'plan-hash': { type: 'string' }, scope: { type: 'string' }, comment: { type: 'string' }, out: { type: 'string' }, github: { type: 'string' }, file: { type: 'string' }, again: { type: 'boolean' }, runtime: { type: 'string' }, 'max-usd': { type: 'string' }, 'reuse-baseline': { type: 'string' }, 'total-usd': { type: 'string' }, model: { type: 'string' }, meta: { type: 'string' }, format: { type: 'string' }, topic: { type: 'string' }, text: { type: 'string' }, users: { type: 'string' }, p95: { type: 'string' }, p99: { type: 'string' }, 'error-rate': { type: 'string' }, requests: { type: 'string' }, path: { type: 'string', multiple: true }, 'file-bugs': { type: 'boolean' }, 'no-baseline': { type: 'boolean' }, list: { type: 'boolean' }, checklist: { type: 'boolean' }, timeout: { type: 'string' } },
  });
  const [cmd, ...rest] = positionals;
  const json = values.json === true;
  try {
    if (!cmd || cmd === 'help' || cmd === '--help') return (c.io.out(HELP), EXIT.ok);
    if (cmd === 'hook') return await hook(c, rest[0]);
    if (cmd === 'eval') return await evalCmd(c, rest, values as Record<string, string | boolean | undefined>, json, await rootOf(c, values.root as string | undefined));
    if (cmd === 'selftest') return await testCmd(c, rest, values as Record<string, string | boolean | undefined>, json, await rootOf(c, values.root as string | undefined));
    if (cmd === 'protocols') return protocols(c, json, await rootOf(c, values.root as string | undefined));
    if (cmd === 'protocol' && rest[0] === 'validate') return validate(c, rest.slice(1));
    const root = await rootOf(c, values.root as string | undefined);
    if (cmd === 'setup') return await setup(c, root, { yes: values.yes === true, github: values.github as string | undefined, json });
    return await withEngine(c, root, cmd, rest, values as Record<string, string | boolean | undefined>, json);
  } catch (e) {
    const code = e instanceof PlError ? e.code : 'PL_INTERNAL';
    c.io.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return code.startsWith('PL_APPROVAL') || code.startsWith('PL_POLICY') ? EXIT.refused : EXIT.error;
  }
}

async function withEngine(c: CliEnv, root: string, cmd: string, rest: string[], v: Record<string, string | boolean | undefined>, json: boolean): Promise<number> {
  const e = await engineOf(c, root);
  if (cmd === 'test') return await projectTest(c, e, rest, v, json);
  if (cmd === 'audit') return await auditCmd(c, e, v, json);
  const protocolId = PROTOCOL_COMMANDS[cmd];
  if (protocolId) {
    const intent = rest.join(' ').trim();
    if (!intent) return (c.io.err(`usage: proofloop ${cmd} "<request>"\n`), EXIT.usage);
    const run = await e.start({ protocolId, intent, again: v.again === true });
    const out = await e.drive(run.id);
    show(c, json, out, outcomeText(out, e.status(run.id).next));
    return exitFor(out);
  }
  const id = rest[0];
  switch (cmd) {
    case 'verify': {
      const r = await e.verifyCurrent(root);
      show(c, json, { runId: r.runId, allRequiredPass: r.allRequiredPass }, r.report);
      return r.allRequiredPass ? EXIT.ok : EXIT.blocked;
    }
    case 'status':
      return status(c, e, id, json);
    case 'wait':
      if (!id) return (c.io.err('usage: proofloop wait <id> [--timeout seconds]\n'), EXIT.usage);
      return await waitFor(c, e, id, Number(v.timeout ?? WAIT_DEFAULT_S), json);
    case 'run':
    case 'resume': {
      if (!id) return (c.io.err(`usage: proofloop ${cmd} <id>\n`), EXIT.usage);
      const out = cmd === 'run' ? await e.drive(id) : await e.resume(id, { retry: v.retry === true });
      show(c, json, out, outcomeText(out, e.status(id).next));
      return exitFor(out);
    }
    case 'approve':
    case 'reject':
      return decide(c, e, cmd, id, v);
    case 'cancel': {
      if (!id) return (c.io.err('usage: proofloop cancel <id>\n'), EXIT.usage);
      const o = await e.cancel(id);
      show(c, json, o, `run ${id}: ${o.state}\n`);
      return EXIT.ok;
    }
    case 'pause':
      if (!id) return (c.io.err('usage: proofloop pause <id>\n'), EXIT.usage);
      e.pause(id);
      c.io.out(`pause requested for ${id}; it takes effect before the next task\n`);
      return EXIT.ok;
    case 'report': {
      if (!id) return (c.io.err('usage: proofloop report <id> [--out file]\n'), EXIT.usage);
      const md = e.report(id);
      const dest = (v.out as string | undefined) ?? join(root, '.proofloop', 'reports', `${id}.md`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, md);
      show(c, json, { path: dest }, `${md}\nwritten to ${dest}\n`);
      return EXIT.ok;
    }
    case 'ledger':
    case 'memory':
    case 'incident':
      return memoryCmd(c, e, cmd, rest, v, json);
    case 'plan':
      return planCmd(c, e, rest, v, json);
    case 'artifact':
      return artifactCmd(c, e, rest, v, json, root);
    case 'perf':
      return perfCmd(c, e, rest, v, json, root);
    case 'readiness': {
      if (!id) return (c.io.err('usage: proofloop readiness <id>\n'), EXIT.usage);
      c.io.out(renderReadiness(e.d.store, id));
      return EXIT.ok;
    }
    case 'start-project':
      return startProject(c, e, rest.join(' ').trim(), json);
    case 'blueprint':
      return blueprintCmd(c, e, rest, v, json);
    default:
      c.io.err(`unknown command "${cmd}"\n${HELP}`);
      return EXIT.usage;
  }
}

type Eng = Awaited<ReturnType<typeof engineOf>>;

function status(c: CliEnv, e: Eng, id: string | undefined, json: boolean): number {
  if (id) {
    const s = e.status(id);
    const gates = s.gates?.gates.map((g) => `  ${g.gateId}: ${g.state}${g.stale ? ' (stale)' : ''}${g.required ? '' : ' (optional)'}`).join('\n') ?? '  (no gate plan yet)';
    show(c, json, s, `run ${id}: ${s.run.state}${s.run.blockedReason ? ` — ${s.run.blockedReason}` : ''}\n  protocol ${s.run.protocolId} · risk ${s.run.risk} · retries ${s.retries} · branch ${s.run.activeBranch ?? '-'}\n  failing gate: ${s.failingGate ?? 'none'} · unsynced GitHub writes: ${s.pendingSync}\ngates:\n${gates}\n  next: ${s.next}\n`);
    return EXIT.ok;
  }
  const runs = e.d.store.listRuns({ activeOnly: true });
  show(c, json, runs.map((r) => ({ id: r.id, protocol: r.protocolId, state: r.state, intent: r.intent })), runs.length ? `${runs.map((r) => `${r.id}  ${r.state.padEnd(16)} ${r.protocolId.padEnd(15)} ${r.intent.slice(0, 60)}`).join('\n')}\n` : 'no active runs\n');
  return EXIT.ok;
}

const WAIT_DEFAULT_S = 540;
const WAIT_POLL_MS = 3000;
const WAIT_STOPS = new Set(['COMPLETE', 'CANCELLED', 'BLOCKED', 'PAUSED', 'AWAITING_APPROVAL', 'REVIEW_REQUIRED', 'PR_OPEN']);

/** Read-only: follow a run (started by the approval hook or a terminal) until it ends, needs a human, or the time is up. */
async function waitFor(c: CliEnv, e: Eng, id: string, seconds: number, json: boolean): Promise<number> {
  const end = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : WAIT_DEFAULT_S) * 1000;
  let last = '';
  for (;;) {
    const state = e.d.store.getRun(id).state;
    if (state !== last) c.io.out(`${new Date().toISOString().slice(11, 19)} ${state}\n`);
    last = state;
    if (WAIT_STOPS.has(state)) break;
    if (Date.now() >= end) return (c.io.out(`still running (${state}); run: proofloop wait ${id}\n`), EXIT.ok);
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
  const code = status(c, e, id, json);
  return last === 'BLOCKED' ? EXIT.blocked : code;
}

function confirmed(c: CliEnv, question: string, yes: boolean): boolean {
  if (yes) return true;
  return c.io.isTTY ? c.io.confirm(question) : false;
}

async function decide(c: CliEnv, e: Eng, cmd: 'approve' | 'reject', id: string | undefined, v: Record<string, string | boolean | undefined>): Promise<number> {
  if (c.env.PROOFLOOP_AGENT_SESSION === '1') throw new PlError('PL_APPROVAL_001', 'refused: agent sessions cannot approve or reject; a human must run this');
  if (!id) return (c.io.err(`usage: proofloop ${cmd} <id> --plan-hash <hash>\n`), EXIT.usage);
  const scope = (v.scope as string | undefined) ?? 'plan';
  const by = humanActor();
  if (cmd === 'reject') {
    rejectPlan(e.d.store, id, { by, comment: String(v.comment ?? 'rejected') });
    c.io.out(`plan rejected; run ${id} returns to planning\n`);
    return EXIT.ok;
  }
  if (scope !== 'plan') return gated(c, e, id, scope, by, v);
  const run = e.d.store.getRun(id);
  const hash = v['plan-hash'] as string | undefined;
  if (!hash) {
    c.io.out(`${renderPlanMarkdown(getPlan(e.d.store, id) as Plan, run.currentPlanHash ?? '', run.planVersion)}\nNot approved. Review the plan above, then run:\n  proofloop approve ${id} --plan-hash ${run.currentPlanHash}\n`);
    return EXIT.ok;
  }
  if (!confirmed(c, `Approve plan ${hash.slice(0, 12)} for ${id}?`, v.yes === true)) throw new PlError('PL_APPROVAL_002', 'approval needs an interactive confirmation or --yes (only after you reviewed the plan)');
  approvePlan(e.d.store, id, { planHash: hash, by, comment: v.comment as string | undefined });
  c.io.out(`plan approved (${hash.slice(0, 12)}); start execution with: proofloop run ${id}\n`);
  return EXIT.ok;
}

function gated(c: CliEnv, e: Eng, id: string, scope: string, by: string, v: Record<string, string | boolean | undefined>): number {
  if (!confirmed(c, `Grant gated approval "${scope}" for ${id}?`, v.yes === true)) throw new PlError('PL_APPROVAL_002', 'gated approval needs an interactive confirmation or --yes');
  approveGated(e.d.store, id, scope, by, v.comment as string | undefined);
  c.io.out(`gated approval recorded for scope "${scope}" (applies to exactly that action)\n`);
  return EXIT.ok;
}

async function planCmd(c: CliEnv, e: Eng, rest: string[], v: Record<string, string | boolean | undefined>, json: boolean): Promise<number> {
  const [sub, id] = rest;
  if (!id) return (c.io.err('usage: proofloop plan show|submit <id> [--file plan.json]\n'), EXIT.usage);
  if (sub === 'show') {
    const run = e.d.store.getRun(id);
    show(c, json, getPlan(e.d.store, id), renderPlanMarkdown(getPlan(e.d.store, id) as Plan, run.currentPlanHash ?? '', run.planVersion));
    return EXIT.ok;
  }
  if (sub === 'submit') {
    const file = v.file as string | undefined;
    const raw = file ? readFileSync(file, 'utf8') : c.io.stdin();
    return await submit(c, id, raw, e);
  }
  return (c.io.err('usage: proofloop plan show|submit <id>\n'), EXIT.usage);
}

async function submit(c: CliEnv, id: string, raw: string, e: Eng): Promise<number> {
  const { submitPlan } = await import('../plan/workflow');
  const r = submitPlan(e.d.store, id, JSON.parse(raw));
  c.io.out(`${r.markdown}\nplan hash: ${r.hash}\n${r.warnings.map((w) => `warning: ${w}\n`).join('')}`);
  return EXIT.ok;
}

async function startProject(c: CliEnv, e: Eng, idea: string, json: boolean): Promise<number> {
  if (!idea) return (c.io.err('usage: proofloop start-project "<one-sentence idea>"\n'), EXIT.usage);
  const run = await e.start({ protocolId: 'idea-to-product', intent: idea });
  const q = nextQuestion(loadInterview(e.d.store, run.id));
  show(c, json, { runId: run.id, next: q }, `run ${run.id}: interview started (your idea is recorded as the outcome)\n${q ? `  next question [${q.topic}]: ${q.question}\n` : '  interview complete\n'}`);
  return EXIT.ok;
}

async function blueprintCmd(c: CliEnv, e: Eng, rest: string[], v: Record<string, string | boolean | undefined>, json: boolean): Promise<number> {
  const [sub, id] = rest;
  if (!id) return (c.io.err('usage: proofloop blueprint next-question|answer|defaults|submit|show <id>\n'), EXIT.usage);
  const st = e.d.store;
  if (sub === 'next-question') {
    const q = nextQuestion(loadInterview(st, id));
    show(c, json, q, q ? `[${q.topic}] ${q.question}\n` : 'interview complete\n');
    return EXIT.ok;
  }
  if (sub === 'answer') {
    const topic = String(v.topic ?? '') as TopicId;
    if (!TOPICS.some((t) => t.id === topic) || !v.text) return (c.io.err(`usage: proofloop blueprint answer <id> --topic ${TOPICS.map((t) => t.id).join('|')} --text "..."\n`), EXIT.usage);
    recordAnswer(st, id, topic, { text: String(v.text), source: 'user' });
    const q = nextQuestion(loadInterview(st, id));
    show(c, json, q, q ? `recorded. next [${q.topic}]: ${q.question}\n` : 'recorded. interview complete\n');
    return EXIT.ok;
  }
  if (sub === 'defaults') {
    const filled = fillDefaults(st, id);
    show(c, json, filled, `${filled.map((f) => `default for ${f.topic}: ${f.text}`).join('\n') || 'nothing to fill'}\nThese are ASSUMPTIONS: list each as an unconfirmed assumption in the blueprint.\n`);
    return EXIT.ok;
  }
  if (sub === 'submit') {
    const raw = v.file ? readFileSync(String(v.file), 'utf8') : c.io.stdin();
    const r = submitBlueprint(st, id, JSON.parse(raw));
    c.io.out(`${r.markdown}\nblueprint hash: ${r.hash}\n${r.warnings.map((w) => `warning: ${w}\n`).join('')}Review, then: proofloop approve ${id} --plan-hash ${r.hash}\n`);
    return EXIT.ok;
  }
  if (sub === 'show') {
    const run = st.getRun(id);
    c.io.out(renderBlueprintMarkdown(getBlueprint(st, id), run.currentPlanHash ?? '', JSON.parse(st.getKey(`needs-confirmation:${id}`) ?? '[]')));
    return EXIT.ok;
  }
  return (c.io.err('usage: proofloop blueprint next-question|answer|defaults|submit|show <id>\n'), EXIT.usage);
}

function artifactCmd(c: CliEnv, e: Eng, rest: string[], v: Record<string, string | boolean | undefined>, json: boolean, root: string): number {
  const [sub, id, name] = rest;
  if (sub === 'list' && id) {
    const items = e.d.store.evidenceFor(id).map((x) => ({ kind: String(x.kind), summary: String(x.summary), commit: x.commit_sha ? String(x.commit_sha).slice(0, 8) : null }));
    show(c, json, items, `${items.map((x) => `${x.kind.padEnd(28)} ${x.commit ?? '-'}  ${x.summary}`).join('\n') || 'no artifacts'}\n`);
    return EXIT.ok;
  }
  if (sub !== 'add' || !id || !name) return (c.io.err('usage: proofloop artifact add <id> <name> (--file path | --text "...") | artifact list <id>\n'), EXIT.usage);
  const content = v.file ? readFileSync(String(v.file), 'utf8') : String(v.text ?? '');
  if (!content.trim()) return (c.io.err('artifact content is empty\n'), EXIT.usage);
  const evd = addArtifact(e.d.store, id, { name, content, artifactDir: join(root, '.proofloop', 'artifacts'), commitSha: e.d.store.getRun(id).headSha ?? undefined });
  c.io.out(`recorded artifact ${name} (${evd})\n`);
  return EXIT.ok;
}

function perfCmd(c: CliEnv, e: Eng, rest: string[], v: Record<string, string | boolean | undefined>, json: boolean, root: string): number {
  const [sub, id] = rest;
  if (!id || !v.file) return (c.io.err('usage: proofloop perf record <id> --file measurement.json | perf import-k6 <id> --file k6.json --meta meta.json\n'), EXIT.usage);
  let input = JSON.parse(readFileSync(String(v.file), 'utf8'));
  if (sub === 'import-k6') {
    if (!v.meta) return (c.io.err('import-k6 needs --meta with phase, environment, workload, target, commit, capturedAt\n'), EXIT.usage);
    input = fromK6Summary(input, JSON.parse(readFileSync(String(v.meta), 'utf8')));
  } else if (sub !== 'record') return (c.io.err('usage: proofloop perf record|import-k6 <id> ...\n'), EXIT.usage);
  const r = recordMeasurement(e.d.store, id, input, join(root, '.proofloop', 'artifacts'));
  show(c, json, r.measurement, `recorded ${r.measurement.phase} (${r.measurement.kind}, n=${sampleCount(r.measurement)}) at ${r.measurement.commit.slice(0, 8)}\n`);
  return EXIT.ok;
}

async function evalCmd(c: CliEnv, rest: string[], v: Record<string, string | boolean | undefined>, json: boolean, root: string): Promise<number> {
  const out = resolve(c.cwd, String(v.out ?? join(root, 'evals', 'reports')));
  mkdirSync(out, { recursive: true });
  if (rest[0] === 'composer') {
    const rep = await runComposerBench(5, 60);
    writeFileSync(join(out, 'composer-bench.json'), `${JSON.stringify(rep, null, 2)}\n`);
    show(c, json, rep, `sequential: ${rep.sequential.roundTrips} round trips, ${rep.sequential.contextBytes} context bytes\ncomposed:   ${rep.composed ? `${rep.composed.roundTrips} round trip, ${rep.composed.contextBytes} context bytes` : 'unavailable on this Node'}\n${rep.note}\nwritten to ${join(out, 'composer-bench.json')}\n`);
    return EXIT.ok;
  }
  const only = rest.length ? rest : undefined;
  if (v.runtime === 'claude') {
    const reuse = v['reuse-baseline'] ? (JSON.parse(readFileSync(String(v['reuse-baseline']), 'utf8')) as Parameters<typeof runRealEvals>[0]['reuse']) : undefined;
    const real = await runRealEvals({ reuse, only, perTaskUsd: Number(v['max-usd'] ?? 1), totalUsd: Number(v['total-usd'] ?? 10), model: v.model as string | undefined, log: (l) => c.io.err(`${l}\n`) });
    writeFileSync(join(out, 'real-model.json'), `${JSON.stringify(real, null, 2)}\n`);
    writeFileSync(join(out, 'real-model.md'), renderRealMarkdown(real));
    show(c, json, real.summary, `${renderRealMarkdown(real)}\nwritten to ${out}\n`);
    return EXIT.ok;
  }
  const rep = await runEvals({ only, log: (l) => c.io.err(`${l}\n`) });
  writeFileSync(join(out, 'latest.json'), `${JSON.stringify(rep, null, 2)}\n`);
  writeFileSync(join(out, 'latest.md'), renderEvalMarkdown(rep));
  show(c, json, rep.summary, `${renderEvalMarkdown(rep)}\nwritten to ${out}\n`);
  return rep.proofloop.every((r) => r.correct) && rep.summary.proofloop.safetyIncidents === 0 ? EXIT.ok : EXIT.error;
}

async function projectTest(c: CliEnv, e: Awaited<ReturnType<typeof engineOf>>, only: string[], v: Record<string, string | boolean | undefined>, json: boolean): Promise<number> {
  const rep = await testCurrent(e.d, { cwd: e.d.root, only, baseline: v['no-baseline'] !== true, github: v['file-bugs'] === true ? e.d.port : null });
  const rows = rep.rows.map((r) => `${r.verdict === 'pass' || r.verdict === 'fixed' ? 'ok  ' : r.verdict === 'gap' ? 'gap ' : 'FAIL'} ${r.gateId.padEnd(14)} ${r.state.padEnd(8)} base:${(r.baseline ?? '-').padEnd(8)} ${r.verdict}`).join('\n');
  show(c, json, rep, `${rows}\n${rep.rows.filter((r) => r.excerpt).map((r) => `\n--- ${r.gateId} failure (tail) ---\n${r.excerpt}\n`).join('')}\n${rep.passed ? 'PASSED' : 'NOT PASSED'}: ${rep.bugs.length} bug(s), ${rep.gaps.length} coverage gap(s)\n${rep.gaps.map((g) => `  gap: ${g}\n`).join('')}report: ${join(rep.dir, 'report.md')}\nlogs:   ${rep.logs}\n`);
  return rep.passed ? EXIT.ok : EXIT.blocked;
}

async function auditCmd(c: CliEnv, e: Awaited<ReturnType<typeof engineOf>>, v: Record<string, string | boolean | string[] | undefined>, json: boolean): Promise<number> {
  if (v.checklist === true) return (c.io.out(`${renderChecklist()}\n`), EXIT.ok);
  const num = (k: string): number | undefined => (v[k] === undefined ? undefined : Number(v[k]));
  const users = num('users') ?? 2000;
  const bad = [['users', users], ['p95', num('p95')], ['p99', num('p99')], ['error-rate', num('error-rate')], ['requests', num('requests')]].find(([, x]) => x !== undefined && (!Number.isFinite(x as number) || (x as number) <= 0));
  if (bad) return (c.io.err(`--${bad[0]} must be a positive number\n`), EXIT.usage);
  const t = { ...(num('p95') ? { p95Ms: num('p95')! } : {}), ...(num('p99') ? { p99Ms: num('p99')! } : {}), ...(num('error-rate') ? { errorRate: num('error-rate')! } : {}) };
  const rep = await runAudit(e.d, { users, targets: t, paths: (v.path as string[] | undefined) ?? [], ...(num('requests') ? { requests: num('requests')! } : {}) });
  const probeLines = rep.probe.results.map((r) => `  ${r.path.padEnd(24)} p50 ${r.p50} ms  p95 ${r.p95} ms  p99 ${r.p99} ms  errors ${r.errors}/${r.n}`).join('\n');
  show(c, json, rep, `Audit for ${users} users: ${rep.status}\n${rep.probe.measured ? probeLines : `  not measured: ${rep.probe.reason}`}\n${rep.probe.violations.map((x) => `  violation: ${x}\n`).join('')}  load test: ${rep.load.command ? `${rep.load.command} -> ${rep.load.state}` : 'none'}\n  static findings: ${rep.findings.length} (${rep.findings.filter((f) => f.severity === 'high').length} high)\n${rep.findings.filter((f) => f.severity === 'high').slice(0, 10).map((f) => `    ${f.rule} ${f.file}:${f.line}\n`).join('')}\nreport: ${join(rep.dir, 'report.md')}\nNow review the system-design checklist against the code (proofloop audit --checklist).\n`);
  return rep.status === 'measured-ok' ? EXIT.ok : EXIT.blocked;
}

async function testCmd(c: CliEnv, rest: string[], v: Record<string, string | boolean | undefined>, json: boolean, root: string): Promise<number> {
  if (v.list === true) return (show(c, json, SUITES, `${Object.entries(SUITES).map(([k, d]) => `${k.padEnd(12)} ${d}`).join('\n')}\nall          every suite above\n`), EXIT.ok);
  const suites = rest.filter((x) => x !== 'all');
  const slug = v['file-bugs'] === true ? (v.github as string | undefined) : undefined;
  const rep = await runSuites({ root, suites, log: (l) => c.io.err(`${l}\n`), ...(slug ? { github: new GhAdapter(slug) } : {}) });
  show(c, json, rep, `${rep.outcomes.map((o) => `${o.correct ? 'pass' : 'FAIL'}  ${o.category.padEnd(12)} ${o.id.padEnd(42)} ${o.finalState} (${o.elapsedMs} ms)`).join('\n')}\n${rep.passed} passed, ${rep.failed} failed. ${rep.bugs.length} bug(s).\n${rep.bugs.map((b) => `  - ${b.title}`).join('\n')}${rep.bugs.length ? '\n' : ''}report: ${join(rep.dir, 'report.md')}\nlog:    ${join(rep.dir, 'log.jsonl')}\n`);
  return rep.failed ? EXIT.error : EXIT.ok;
}

function protocols(c: CliEnv, json: boolean, root: string): number {
  const reg = loadRegistry(root);
  const list = reg.list().map((p) => ({ id: p.id, version: p.version, mode: p.mode, risk: p.defaultRisk, title: p.title }));
  show(c, json, { engine: ENGINE_VERSION, protocols: list, diagnostics: reg.diagnostics }, `ProofLoop ${ENGINE_VERSION}\n${list.map((p) => `${p.id.padEnd(16)} v${p.version}  ${p.mode.padEnd(15)} ${p.title}`).join('\n')}\n${reg.diagnostics.map((d) => `! ${d.file}: ${d.path}: ${d.message}\n`).join('')}`);
  return reg.diagnostics.length ? EXIT.error : EXIT.ok;
}

function validate(c: CliEnv, files: string[]): number {
  if (files.length === 0) return (c.io.err('usage: proofloop protocol validate <file.yaml...>\n'), EXIT.usage);
  let bad = 0;
  for (const f of files) {
    const { diagnostics } = parseProtocol(readFileSync(resolve(c.cwd, f), 'utf8'), f);
    if (diagnostics.length === 0) c.io.out(`ok  ${f}\n`);
    for (const d of diagnostics) {
      bad++;
      c.io.err(`${d.file}${d.line ? `:${d.line}` : ''}  ${d.path}: ${d.message}\n`);
    }
  }
  return bad ? EXIT.error : EXIT.ok;
}

const promptContext = (additionalContext: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } });

/**
 * The user's one-word approval in chat. It arrives through UserPromptSubmit, so it is a human act no agent can forge;
 * the hook records it for the plan hash currently awaiting approval and starts the run in the background.
 */
async function approveByPrompt(c: CliEnv, cwd: string, wanted?: string): Promise<string> {
  const root = await rootOf({ ...c, cwd });
  if (!existsSync(join(root, '.proofloop'))) return '';
  const e = await engineOf(c, root);
  const waiting = e.d.store.listRuns({ activeOnly: true }).filter((r) => r.state === 'AWAITING_APPROVAL' && (!wanted || r.id === wanted));
  const run = waiting[0];
  if (!run?.currentPlanHash) return '';
  if (waiting.length > 1) return promptContext(`Several plans await approval (${waiting.map((r) => r.id).join(', ')}). Nothing was approved. Ask the user which one, and tell them to reply "approve <run-id>".`);
  approvePlan(e.d.store, run.id, { planHash: run.currentPlanHash, by: humanActor(), comment: 'approved by the user in chat' });
  const log = join(root, '.proofloop', 'logs', `run-${run.id}.log`);
  mkdirSync(dirname(log), { recursive: true });
  (c.startRun ?? ((r, id, file) => detachedRun(r, id, file, c.env)))(root, run.id, log);
  return promptContext(approvedContext(run.id, run.currentPlanHash, log));
}

function detachedRun(root: string, runId: string, log: string, env: NodeJS.ProcessEnv): void {
  const fd = openSync(log, 'a');
  spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'run', runId, '--root', root], { detached: true, stdio: ['ignore', fd, fd], env }).unref();
}

async function hook(c: CliEnv, event: string | undefined): Promise<number> {
  if (event === 'user-prompt') {
    try {
      const input = JSON.parse(c.io.stdin()) as { prompt?: unknown; cwd?: unknown };
      const prompt = String(input.prompt ?? '');
      const approval = approvalRequest(prompt);
      c.io.out(approval ? await approveByPrompt(c, typeof input.cwd === 'string' ? input.cwd : c.cwd, approval.runId) : promptHookOutput(prompt));
    } catch {
      /* fail open: this hook only adds context */
    }
    return 0;
  }
  if (event !== 'pre-tool-use') return (c.io.err('usage: proofloop hook pre-tool-use|user-prompt\n'), EXIT.usage);
  let input;
  try {
    input = JSON.parse(c.io.stdin());
  } catch {
    c.io.err('ProofLoop hook: unreadable input; refusing (fail closed)\n');
    return 2;
  }
  const d = evaluateHook(input, c.env);
  c.io.out(hookOutput(d));
  return 0;
}

async function setup(c: CliEnv, root: string, o: { yes: boolean; github?: string | undefined; json: boolean }): Promise<number> {
  const git = new Git();
  const claude = new ClaudeCodeRuntime();
  const cv = await claude.checkVersion();
  const gh = await nodeExec('gh', ['auth', 'status'], { timeoutMs: 15_000 });
  const detected = detectRepo(root);
  const repo = o.github ?? (await git.remoteRepo(root));
  const checks = [
    { name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version },
    { name: 'git repository', ok: await git.isRepo(root), detail: root },
    { name: 'claude code', ok: cv.ok, detail: cv.version ?? cv.problem ?? 'missing' },
    { name: 'gh (optional)', ok: gh.code === 0, detail: gh.spawnError ? 'not installed' : gh.code === 0 ? 'authenticated' : 'not authenticated' },
  ];
  const cfg = configSchema.parse({ github: { enabled: Boolean(repo) && gh.code === 0, ...(repo ? { repo } : {}) }, commands: {} });
  const exists = existsSync(configPath(root));
  if (o.yes && !exists) writeConfig(root, cfg);
  const text = `ProofLoop ${ENGINE_VERSION} self-check (read-only)\n${checks.map((k) => `  ${k.ok ? 'ok ' : '!! '} ${k.name}: ${k.detail}`).join('\n')}\n\nDetected: ${detected.languages.join(', ') || 'nothing recognised'}${detected.packageManager ? ` (${detected.packageManager})` : ''}\n  commands: ${JSON.stringify(detected.commands)}\n${detected.limitations.map((l) => `  limitation: ${l}\n`).join('')}\nPermissions ProofLoop needs and why: read the repo; create branches/worktrees under .proofloop/; run only the gate commands you approve in a plan; write issues/PRs through your own gh login (no token is stored). It never disables Claude Code permissions.\n${exists ? `Config exists: ${configPath(root)}\n` : o.yes ? `Wrote ${configPath(root)}\n` : `Would write ${configPath(root)} with GitHub ${cfg.github.enabled ? `enabled (${repo})` : 'disabled'}. Re-run with --yes to create it.\n`}`;
  show(c, o.json, { checks, detected, config: cfg }, text);
  return checks.slice(0, 3).every((k) => k.ok) ? EXIT.ok : EXIT.error;
}

async function memoryCmd(c: CliEnv, e: Eng, cmd: string, rest: string[], v: Record<string, string | boolean | undefined>, json: boolean): Promise<number> {
  const [sub, id] = cmd === 'ledger' ? rest : cmd === 'memory' ? ['show', rest[0]] : rest;
  if (cmd === 'ledger') {
    if (sub !== 'export' || !id) return (c.io.err('usage: proofloop ledger export <task-id> [--format json|markdown] [--out file]\n'), EXIT.usage);
    const format = String(v.format ?? 'json');
    if (format !== 'json' && format !== 'markdown') return (c.io.err('--format must be json or markdown\n'), EXIT.usage);
    const ledger = await ledgerFor(e.d, id);
    const text = format === 'json' ? `${JSON.stringify(ledger, null, 2)}\n` : renderLedgerMarkdown(ledger);
    if (v.out) {
      mkdirSync(dirname(String(v.out)), { recursive: true });
      writeFileSync(String(v.out), text);
      c.io.out(`ledger (${format}) written to ${String(v.out)}\n`);
    } else c.io.out(text);
    return EXIT.ok;
  }
  if (cmd === 'memory') {
    const m = id ? storedMemory(e.d, id) : null;
    if (!m) return (c.io.err(`no historical memory recorded for ${id ?? '(no id)'}\n`), EXIT.error);
    show(c, json, m, `${memoryForPrompt(m)}\n`);
    return EXIT.ok;
  }
  const repo = incidentsOf(e.d);
  if (sub === 'list') {
    const list = repo.list(await repositoryIdOf(e.d));
    show(c, json, list, `${list.map((i) => `${i.id}  ${i.status}  ${i.title}`).join('\n') || 'no incidents recorded'}\n`);
    return EXIT.ok;
  }
  const inc = id ? repo.get(id) : null;
  if (!inc) return (c.io.err(`unknown incident ${id ?? '(no id)'}\n`), EXIT.error);
  if (sub === 'confirm') {
    if (c.env.PROOFLOOP_AGENT_SESSION === '1') throw new PlError('PL_APPROVAL_001', 'refused: agent sessions cannot confirm a root cause; a human must run this');
    if (!v.text) return (c.io.err('usage: proofloop incident confirm <id> --text "<root cause>" --yes\n'), EXIT.usage);
    if (!confirmed(c, `Record "${String(v.text)}" as the confirmed root cause of ${inc.id}?`, v.yes === true)) throw new PlError('PL_APPROVAL_002', 'confirming a root cause needs an interactive confirmation or --yes');
    repo.confirmRootCause(inc.id, String(v.text), humanActor());
    c.io.out(`root cause recorded for ${inc.id} by a human decision\n`);
    return EXIT.ok;
  }
  show(c, json, inc, `${inc.id} [${inc.status}] ${inc.title}\nconfirmed root cause: ${inc.confirmedRootCause ?? 'none'}\nhypotheses: ${inc.rootCauseHypotheses.map((h) => `[${h.status}] ${h.description}`).join('; ') || 'none'}\nattempts: ${inc.attemptedFixes.map((a) => `${a.id}:${a.outcome}`).join(', ') || 'none'}\nregression tests: ${inc.regressionTests.map((t) => t.name).join(', ') || 'none'}\n`);
  return EXIT.ok;
}
