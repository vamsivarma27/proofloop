import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { evaluateHook, hookOutput } from './hook';
import { renderPlanMarkdown } from '../plan/schema';
import { getPlan } from '../plan/workflow';
import type { Plan } from '../plan/schema';

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
}

export const EXIT = { ok: 0, error: 1, usage: 2, refused: 3, blocked: 10, paused: 11 } as const;
const PROTOCOL_COMMANDS: Record<string, string> = { feature: 'feature', bug: 'bug', diagnose: 'troubleshooting', performance: 'performance', refactor: 'refactor', security: 'security' };
const HELP = `proofloop ${ENGINE_VERSION}

Task commands:  feature|bug|diagnose|performance|refactor|security "<request>"
Lifecycle:      status [id] · approve <id> --plan-hash H [--scope S] · reject <id> --comment C · run <id> · resume <id> [--retry] · cancel <id> · pause <id>
Evidence:       verify · report <id> [--out file] · plan show <id>
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
    options: { root: { type: 'string' }, json: { type: 'boolean' }, yes: { type: 'boolean' }, retry: { type: 'boolean' }, 'plan-hash': { type: 'string' }, scope: { type: 'string' }, comment: { type: 'string' }, out: { type: 'string' }, github: { type: 'string' }, file: { type: 'string' }, again: { type: 'boolean' } },
  });
  const [cmd, ...rest] = positionals;
  const json = values.json === true;
  try {
    if (!cmd || cmd === 'help' || cmd === '--help') return (c.io.out(HELP), EXIT.ok);
    if (cmd === 'hook') return hook(c, rest[0]);
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
    case 'plan':
      return planCmd(c, e, rest, v, json);
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

function hook(c: CliEnv, event: string | undefined): number {
  if (event !== 'pre-tool-use') return (c.io.err('usage: proofloop hook pre-tool-use\n'), EXIT.usage);
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
