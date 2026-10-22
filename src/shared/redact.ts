const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack-token]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED:credential]'],
  [/\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[REDACTED:userinfo]@'],
  [
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"']{4,}["']?/gi,
    '$1=[REDACTED]',
  ],
];

const EMAIL = /\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g;

/** Redacts secrets and masks PII (email -> j***@host, IPv4 -> a.b.*.*) before anything is persisted. */
export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  out = out.replace(EMAIL, (_m, first: string, host: string) => `${first}***@${host}`);
  return out.replace(IPV4, '$1.$2.*.*');
}

const SENSITIVE_KEY = /secret|token|password|passwd|api_?key|credential|private_?key|authorization/i;

export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactValue) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) && typeof v === 'string' ? '[REDACTED]' : redactValue(v),
      ]),
    ) as T;
  }
  return value;
}

/** Environment passed to child processes: only an allowlist, never ambient credentials. */
export function scrubbedEnv(source: NodeJS.ProcessEnv, allow: readonly string[] = DEFAULT_ENV_ALLOW): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allow) {
    const v = source[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

export const DEFAULT_ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'CI', 'NODE_ENV', 'SHELL'] as const;
