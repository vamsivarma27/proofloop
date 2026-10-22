import { PlError } from '../shared/errors';

export type CommandClass = 'allowed' | 'unlisted' | 'destructive' | 'critical' | 'network' | 'malformed';
export interface CommandDecision {
  verdict: 'allow' | 'deny' | 'needs_approval';
  cls: CommandClass;
  reason: string;
  /** Scope string an explicit gated approval must carry to override a needs_approval verdict. */
  approvalScope?: string;
  argv: string[];
}

const SHELL_META = /[|;&<>`\n\r]|\$\(|\$\{/;

/** Tokenizes a command line without a shell. Quotes group; any shell operator is rejected outright. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      if (SHELL_META.test(ch)) throw new PlError('PL_POLICY_001', `shell operator "${ch}" is not allowed; run one program with explicit arguments`);
      cur += ch;
    }
  }
  if (quote) throw new PlError('PL_POLICY_002', 'unterminated quote');
  if (has || cur) out.push(cur);
  if (/\$\(|\$\{/.test(line)) throw new PlError('PL_POLICY_001', 'command substitution is not allowed');
  return out;
}

interface Rule {
  re: RegExp;
  cls: 'destructive' | 'critical' | 'network';
  why: string;
}

/** Matched against the joined argv. Critical = production/irreversible; needs approval immediately before the action. */
const RULES: readonly Rule[] = [
  { re: /(^|\s)sudo(\s|$)/, cls: 'critical', why: 'privilege escalation' },
  { re: /\brm\b(?=.*\s-[a-z]*r)(?=.*\s-[a-z]*f)|\brm\b.*--recursive/i, cls: 'destructive', why: 'recursive delete' },
  { re: /\bgit\b.*\bpush\b.*(--force|-f\b|--delete|\s\+)/, cls: 'critical', why: 'force/destructive push' },
  { re: /\bgit\b.*\b(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D)/, cls: 'destructive', why: 'discards work' },
  { re: /\b(terraform|tofu)\b.*\b(apply|destroy)\b/, cls: 'critical', why: 'infrastructure change' },
  { re: /\bkubectl\b.*\b(delete|apply|replace|patch|scale|rollout)\b/, cls: 'critical', why: 'cluster mutation' },
  { re: /\bhelm\b.*\b(install|upgrade|uninstall|rollback)\b/, cls: 'critical', why: 'cluster mutation' },
  { re: /\b(docker|podman)\s+push\b/, cls: 'critical', why: 'publishes an image' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/, cls: 'critical', why: 'publishes a package' },
  { re: /\bgh\s+(release\s+(create|delete)|repo\s+(delete|edit)|api\b.*(-X|--method)\s*(DELETE|PUT|PATCH))/i, cls: 'critical', why: 'GitHub destructive/admin call' },
  { re: /\b(vercel|netlify|fly|flyctl|serverless|cdk)\b.*\b(deploy|--prod|destroy)\b/, cls: 'critical', why: 'production deployment' },
  { re: /\b(deploy|release)\b.*\b(prod|production)\b/i, cls: 'critical', why: 'production deployment' },
  { re: /\b(drop|truncate)\s+(table|database|schema)\b|\bdelete\s+from\b/i, cls: 'critical', why: 'destructive SQL' },
  { re: /\b(psql|mysql|mongosh|redis-cli|sqlite3)\b.*\b(prod|production)\b/i, cls: 'critical', why: 'production database' },
  { re: /\b(migrate|migration)\b.*\b(prod|production)\b/i, cls: 'critical', why: 'production migration' },
  { re: /\b(chmod|chown)\s+-R\b/, cls: 'destructive', why: 'recursive permission change' },
  { re: /^(curl|wget|nc|ncat|ssh|scp|rsync|ftp|telnet)\b/, cls: 'network', why: 'network access' },
];

export interface CommandPolicy {
  /** Exact argv prefixes that are pre-approved (detected scripts + user config). */
  allowed: readonly string[][];
}

export const argvPrefixMatches = (argv: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length > 0 && prefix.length <= argv.length && prefix.every((p, i) => p === argv[i]);

export function evaluateCommand(line: string, policy: CommandPolicy): CommandDecision {
  let argv: string[];
  try {
    argv = tokenize(line);
  } catch (e) {
    return { verdict: 'deny', cls: 'malformed', reason: e instanceof Error ? e.message : String(e), argv: [] };
  }
  if (argv.length === 0) return { verdict: 'deny', cls: 'malformed', reason: 'empty command', argv };
  const joined = argv.join(' ');
  for (const r of RULES) {
    if (r.re.test(joined))
      return { verdict: 'needs_approval', cls: r.cls, reason: r.why, approvalScope: `${r.cls}:${joined}`, argv };
  }
  if (policy.allowed.some((p) => argvPrefixMatches(argv, p))) return { verdict: 'allow', cls: 'allowed', reason: 'allowlisted', argv };
  return { verdict: 'deny', cls: 'unlisted', reason: `"${argv[0]}" is not on the command allowlist; add it to .proofloop/config.json allowedCommands`, argv };
}

/** Splits a command line on shell separators and substitutions so each piece can be judged on its own. */
export function commandSegments(line: string): string[] {
  return line.split(/&&|\|\||[;|&\n`]|\$\(|\)/).map((x) => x.trim()).filter(Boolean);
}
