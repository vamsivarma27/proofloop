import { type RiskLevel, riskRank } from '../protocol/schema';

const HIGH_PATHS: readonly RegExp[] = [
  /(^|\/)(auth|authn|authz|rbac|permissions?|tenant|billing|payments?|crypto|secrets?|security)(\/|\.|-|_)/i,
  /(^|\/)migrations?\//i,
  /(^|\/)(schema|schemas)\.[a-z]+$/i,
  /\.sql$/i,
  /(^|\/)(Dockerfile|docker-compose[^/]*|terraform|infra|k8s|helm|\.github\/workflows)(\/|$|\.)/i,
  /(^|\/)(\.env[^/]*|config\/production[^/]*)$/i,
];
const LOW_ONLY: readonly RegExp[] = [/\.(md|mdx|txt|rst)$/i, /^docs\//i, /(^|\/)CHANGELOG/i];

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskRank(a) >= riskRank(b) ? a : b;
}

/** Engine-computed floor. Callers may only raise risk with this; nothing in the engine lowers it. */
export function classifyRisk(changedPaths: readonly string[], opts: { destructiveOp?: boolean } = {}): RiskLevel {
  if (opts.destructiveOp) return 'critical';
  if (changedPaths.some((p) => HIGH_PATHS.some((re) => re.test(p)))) return 'high';
  if (changedPaths.length > 0 && changedPaths.every((p) => LOW_ONLY.some((re) => re.test(p)))) return 'low';
  return 'medium';
}
