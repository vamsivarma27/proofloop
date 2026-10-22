import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineCounter, parseDocument } from 'yaml';
import type { ZodError } from 'zod';
import { PlError } from '../shared/errors';
import { ENGINE_VERSION } from '../version';
import { type Protocol, protocolSchema } from './schema';

export interface Diagnostic {
  file: string;
  line?: number;
  path: string;
  message: string;
}

const versionParts = (v: string): number[] => v.split('-')[0]!.split('.').map(Number);

export function engineSatisfies(range: string, engine = ENGINE_VERSION): boolean {
  const need = versionParts(range.replace('>=', ''));
  const have = versionParts(engine);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) !== (need[i] ?? 0)) return (have[i] ?? 0) > (need[i] ?? 0);
  }
  return true;
}

function zodDiagnostics(file: string, error: ZodError): Diagnostic[] {
  return error.issues.map((i) => ({ file, path: i.path.join('.') || '(root)', message: i.message }));
}

/** Parses and validates one protocol document, returning actionable diagnostics instead of throwing. */
export function parseProtocol(source: string, file = '<inline>'): { protocol?: Protocol; diagnostics: Diagnostic[] } {
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines, prettyErrors: false });
  if (doc.errors.length > 0) {
    return {
      diagnostics: doc.errors.map((e) => ({
        file,
        line: lines.linePos(e.pos[0]).line,
        path: '(yaml)',
        message: e.message.split('\n')[0] ?? 'invalid YAML',
      })),
    };
  }
  const parsed = protocolSchema.safeParse(doc.toJS());
  if (!parsed.success) return { diagnostics: zodDiagnostics(file, parsed.error) };
  if (!engineSatisfies(parsed.data.engine))
    return {
      diagnostics: [
        { file, path: 'engine', message: `protocol needs engine ${parsed.data.engine}, running ${ENGINE_VERSION}; upgrade ProofLoop or lower the requirement` },
      ],
    };
  return { protocol: parsed.data, diagnostics: [] };
}

export function pluginRoot(from = import.meta.url): string {
  let dir = dirname(fileURLToPath(from));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    dir = dirname(dir);
  }
  throw new PlError('PL_PROTOCOL_001', 'cannot locate the ProofLoop plugin root');
}

export class ProtocolRegistry {
  private readonly byId = new Map<string, Protocol>();
  readonly diagnostics: Diagnostic[] = [];

  loadDir(dir: string): void {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
      const file = join(dir, f);
      const { protocol, diagnostics } = parseProtocol(readFileSync(file, 'utf8'), file);
      this.diagnostics.push(...diagnostics);
      if (!protocol) continue;
      const clash = this.byId.get(protocol.id);
      if (clash) {
        this.diagnostics.push({ file, path: 'id', message: `protocol "${protocol.id}" is already registered (v${clash.version}); pick a unique id` });
        continue;
      }
      this.byId.set(protocol.id, protocol);
    }
  }

  get(id: string): Protocol {
    const p = this.byId.get(id);
    if (!p) throw new PlError('PL_PROTOCOL_002', `unknown protocol "${id}"; installed: ${[...this.byId.keys()].join(', ') || 'none'}`);
    return p;
  }

  list(): Protocol[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

/** Built-in protocols plus any project-local ones from .proofloop/protocols. */
export function loadRegistry(repoRoot?: string, root = pluginRoot()): ProtocolRegistry {
  const reg = new ProtocolRegistry();
  reg.loadDir(join(root, 'protocols'));
  if (repoRoot) reg.loadDir(join(repoRoot, '.proofloop', 'protocols'));
  return reg;
}
