import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalToolComposer, sandboxSupport } from '../composer/local';
import { buildTools } from '../composer/tools';
import { Git } from '../git/git';

export interface BenchRow {
  mode: 'sequential' | 'composed';
  /** Model round trips: one per tool call when sequential, one program when composed. */
  roundTrips: number;
  toolCalls: number;
  /** Bytes of tool output that would enter the model's context. */
  contextBytes: number;
  wallMs: number;
}

export interface BenchReport {
  task: string;
  repetitions: number;
  environment: { node: string; platform: string; files: number };
  sequential: BenchRow;
  composed: BenchRow | null;
  note: string;
}

const KEYWORD = 'billing';

export async function makeFixtureRepo(files = 60): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'pl-bench-'));
  const git = new Git();
  await git.run(root, ['init', '-q', '-b', 'main']);
  await git.run(root, ['config', 'user.email', 'b@example.com']);
  await git.run(root, ['config', 'user.name', 'Bench']);
  for (let i = 0; i < files; i++) {
    const name = i % 6 === 0 ? `src/billing/invoice${i}.ts` : `src/mod${i % 5}/file${i}.ts`;
    mkdirSync(dirname(join(root, name)), { recursive: true });
    const body = Array.from({ length: 40 }, (_, l) => `export const v${i}_${l} = ${l}; // ${i % 6 === 0 ? KEYWORD : 'misc'} line`).join('\n');
    writeFileSync(join(root, name), `import './common';\n${body}\n`);
  }
  writeFileSync(join(root, 'src/common.ts'), 'export const common = 1;\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'x', lint: 'x' } }));
  await git.run(root, ['add', '-A']);
  await git.run(root, ['commit', '-q', '-m', 'chore: fixture']);
  return root;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '');

async function sequential(root: string): Promise<BenchRow> {
  const tools = new Map(buildTools().map((t) => [t.name, t]));
  const call = (name: string, input: unknown): Promise<unknown> => tools.get(name)!.handler(tools.get(name)!.input.parse(input), { root });
  const t0 = Date.now();
  let calls = 0;
  let ctx = 0;
  const step = async (name: string, input: unknown): Promise<unknown> => {
    const out = await call(name, input);
    calls++;
    ctx += bytes(out);
    return out;
  };
  const files = (await step('repo.findRelevantFiles', { keywords: [KEYWORD], limit: 5 })) as Array<{ path: string }>;
  for (const f of files.slice(0, 3)) {
    await step('repo.readFileRange', { path: f.path, start: 1, end: 40 });
    await step('repo.traceDependencies', { path: f.path });
  }
  await step('tests.discoverSuites', {});
  return { mode: 'sequential', roundTrips: calls, toolCalls: calls, contextBytes: ctx, wallMs: Date.now() - t0 };
}

const PROGRAM = `
  const files = await tools.repo.findRelevantFiles({ keywords: ['${KEYWORD}'], limit: 5 });
  const report = [];
  for (const f of files.slice(0, 3)) {
    const text = await tools.repo.readFileRange({ path: f.path, start: 1, end: 40 });
    const deps = await tools.repo.traceDependencies({ path: f.path });
    report.push({ path: f.path, firstLine: text.text.split('\\n')[1], imports: deps.imports.length, importedBy: deps.importedBy.length });
  }
  const suites = await tools.tests.discoverSuites({});
  return { report, commands: Object.keys(suites.commands) };
`;

async function composed(root: string): Promise<BenchRow | null> {
  const c = new LocalToolComposer({ root });
  const t0 = Date.now();
  const r = await c.run(PROGRAM);
  if (!r.ok) return null;
  return { mode: 'composed', roundTrips: 1, toolCalls: r.calls.length, contextBytes: r.bytesOut, wallMs: Date.now() - t0 };
}

/**
 * Compares sequential tool use against one composed program on a discovery task. It measures round trips and bytes
 * entering model context. It does NOT measure model latency or cost, so no speed or cost claim follows from it.
 */
export async function runComposerBench(repetitions = 5, files = 60): Promise<BenchReport> {
  const root = await makeFixtureRepo(files);
  const seq: BenchRow[] = [];
  const com: BenchRow[] = [];
  for (let i = 0; i < repetitions; i++) {
    seq.push(await sequential(root));
    const c = sandboxSupport().ok ? await composed(root) : null;
    if (c) com.push(c);
  }
  const pick = (rows: BenchRow[]): BenchRow => ({ ...rows[0]!, contextBytes: median(rows.map((r) => r.contextBytes)), wallMs: median(rows.map((r) => r.wallMs)) });
  return {
    task: `find files relevant to "${KEYWORD}", read 3 ranges, trace their dependencies, list detected test commands`,
    repetitions,
    environment: { node: process.version, platform: `${process.platform}-${process.arch}`, files },
    sequential: pick(seq),
    composed: com.length ? pick(com) : null,
    note: 'wallMs covers tool execution only (including sandbox start-up); model latency and token cost are not measured. Context bytes are a proxy for tokens.',
  };
}
