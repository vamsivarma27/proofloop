import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GateKind } from '../protocol/schema';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface DetectedRepo {
  root: string;
  languages: string[];
  packageManager: PackageManager | null;
  /** Only commands actually found in the repo. A missing key means "not detected", never a guess. */
  commands: Partial<Record<GateKind, string>>;
  startCommands: string[];
  ci: string[];
  limitations: string[];
}

const SCRIPT_CANDIDATES: ReadonlyArray<[GateKind, readonly string[]]> = [
  ['format', ['format:check', 'format-check', 'fmt:check', 'prettier:check']],
  ['lint', ['lint']],
  ['typecheck', ['typecheck', 'type-check', 'check-types', 'tsc']],
  ['unit', ['test:unit', 'test']],
  ['build', ['build']],
  ['integration', ['test:integration', 'integration']],
  ['browser', ['test:e2e', 'e2e', 'test:browser', 'playwright']],
  ['security-scan', ['audit', 'security', 'scan']],
  ['migration', ['migrate:check', 'db:check']],
];
const START_SCRIPTS = ['dev', 'start', 'serve'];

const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null);

function detectPackageManager(root: string, pkg: { packageManager?: string } | null): PackageManager {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  if (existsSync(join(root, 'package-lock.json'))) return 'npm';
  const field = pkg?.packageManager?.split('@')[0];
  return field === 'pnpm' || field === 'yarn' || field === 'bun' ? field : 'npm';
}

function detectNode(root: string, out: DetectedRepo): void {
  const raw = read(join(root, 'package.json'));
  if (!raw) return;
  let pkg: { scripts?: Record<string, string>; packageManager?: string };
  try {
    pkg = JSON.parse(raw);
  } catch {
    out.limitations.push('package.json is not valid JSON; Node scripts not detected');
    return;
  }
  out.languages.push('javascript/typescript');
  const pm = detectPackageManager(root, pkg);
  out.packageManager = pm;
  const scripts = pkg.scripts ?? {};
  for (const [kind, names] of SCRIPT_CANDIDATES) {
    const found = names.find((n) => scripts[n]);
    if (found && !out.commands[kind]) out.commands[kind] = `${pm} run ${found}`;
  }
  for (const s of START_SCRIPTS) if (scripts[s]) out.startCommands.push(`${pm} run ${s}`);
}

function detectPython(root: string, out: DetectedRepo): void {
  const pyproject = read(join(root, 'pyproject.toml'));
  const hasPy = pyproject !== null || existsSync(join(root, 'setup.py')) || existsSync(join(root, 'pytest.ini')) || existsSync(join(root, 'requirements.txt'));
  if (!hasPy) return;
  out.languages.push('python');
  const run = existsSync(join(root, 'uv.lock')) ? 'uv run ' : '';
  const text = `${pyproject ?? ''}\n${read(join(root, 'pytest.ini')) ?? ''}\n${read(join(root, 'requirements.txt')) ?? ''}`;
  if (/pytest/.test(text) || existsSync(join(root, 'tests'))) out.commands.unit ??= `${run}pytest`;
  if (/\[tool\.ruff/.test(text)) out.commands.lint ??= `${run}ruff check .`;
  if (/\[tool\.mypy|mypy/.test(text)) out.commands.typecheck ??= `${run}mypy .`;
}

function detectOthers(root: string, out: DetectedRepo): void {
  if (existsSync(join(root, 'go.mod'))) {
    out.languages.push('go');
    out.commands.unit ??= 'go test ./...';
    out.commands.build ??= 'go build ./...';
    out.commands.lint ??= 'go vet ./...';
  }
  if (existsSync(join(root, 'Cargo.toml'))) {
    out.languages.push('rust');
    out.commands.unit ??= 'cargo test';
    out.commands.build ??= 'cargo build';
    out.commands.lint ??= 'cargo clippy -- -D warnings';
  }
  const make = read(join(root, 'Makefile'));
  if (make) {
    const has = (t: string): boolean => new RegExp(`^${t}:`, 'm').test(make);
    if (has('test')) out.commands.unit ??= 'make test';
    if (has('lint')) out.commands.lint ??= 'make lint';
    if (has('build')) out.commands.build ??= 'make build';
  }
}

export function detectRepo(root: string): DetectedRepo {
  const out: DetectedRepo = { root, languages: [], packageManager: null, commands: {}, startCommands: [], ci: [], limitations: [] };
  detectNode(root, out);
  detectPython(root, out);
  detectOthers(root, out);
  const wf = join(root, '.github', 'workflows');
  if (existsSync(wf)) out.ci = readdirSync(wf).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`);
  if (out.languages.length === 0) out.limitations.push('no recognised project files (package.json, pyproject.toml, go.mod, Cargo.toml, Makefile) found');
  for (const kind of ['lint', 'typecheck', 'unit', 'build'] as const)
    if (!out.commands[kind]) out.limitations.push(`no ${kind} command detected; set commands.${kind} in .proofloop/config.json or the ${kind} gate will be BLOCKED`);
  return out;
}
