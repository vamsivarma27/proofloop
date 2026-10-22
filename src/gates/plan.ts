import type { Config } from '../config';
import type { DetectedRepo } from '../repo/detect';
import { type GateKind, type Protocol, type RiskLevel, riskRank } from '../protocol/schema';

export interface GatePlanEntry {
  gateId: string;
  kind: GateKind;
  required: boolean;
  /** null => cannot run; the gate will be BLOCKED rather than guessed. */
  command: string | null;
  source: 'plan' | 'config' | 'detected' | 'builtin' | 'none';
  /** Repo does not support this standard check; below high risk it is reported as a limitation, not demanded. */
  unsupported?: boolean;
}

/** Gate ids evaluated in-process from recorded artifacts rather than by an external command. */
export const BUILTIN_GATES: readonly string[] = ['baseline-recorded', 'before-after', 'baseline-green', 'contract-drift', 'blueprint-valid', 'assumptions-visible', 'evidence-preserved'];

export function resolveCommand(
  gate: { id: string; kind: GateKind },
  detected: Pick<DetectedRepo, 'commands'>,
  config: Pick<Config, 'commands'>,
  planCommands: Record<string, string> = {},
): Pick<GatePlanEntry, 'command' | 'source'> {
  const byConfig = (config.commands as Record<string, string | undefined>)[gate.id] ?? (config.commands as Record<string, string | undefined>)[gate.kind];
  if (planCommands[gate.id]) return { command: planCommands[gate.id]!, source: 'plan' };
  if (BUILTIN_GATES.includes(gate.id)) return { command: `builtin:${gate.id}`, source: 'builtin' };
  if (byConfig) return { command: byConfig, source: 'config' };
  const found = detected.commands[gate.kind];
  return found ? { command: found, source: 'detected' } : { command: null, source: 'none' };
}

/** Standard repository checks: required only where the repository actually supports them (PRD 15.2). */
const STANDARD_KINDS: readonly GateKind[] = ['format', 'lint', 'typecheck', 'unit', 'build', 'integration', 'security-scan', 'browser', 'migration'];

/**
 * Gate plan = protocol gates at or below the task's risk. Standard checks the repo cannot run are downgraded to
 * reported limitations below high risk; at high/critical risk they stay required and therefore BLOCK.
 */
export function buildGatePlan(
  protocol: Protocol,
  risk: RiskLevel,
  detected: Pick<DetectedRepo, 'commands'>,
  config: Pick<Config, 'commands'>,
  planCommands: Record<string, string> = {},
): GatePlanEntry[] {
  return protocol.gates
    .filter((g) => riskRank(risk) >= riskRank(g.minRisk))
    .map((g) => {
      const bound = resolveCommand(g, detected, config, planCommands);
      const unsupported = bound.command === null && STANDARD_KINDS.includes(g.kind) && riskRank(risk) < riskRank('high');
      return { gateId: g.id, kind: g.kind, required: g.required && !unsupported, ...bound, ...(unsupported ? { unsupported: true } : {}) };
    });
}

/** Engine-added gate, always required: tests may not be weakened to get green. */
export const TEST_INTEGRITY_GATE: GatePlanEntry = { gateId: 'test-integrity', kind: 'custom', required: true, command: 'builtin:test-integrity', source: 'builtin' };

export const AC_TRACEABILITY_GATE: GatePlanEntry = { gateId: 'ac-traceability', kind: 'custom', required: true, command: 'builtin:ac-traceability', source: 'builtin' };

export const REQUIRED_ARTIFACTS_GATE: GatePlanEntry = { gateId: 'required-artifacts', kind: 'custom', required: true, command: 'builtin:required-artifacts', source: 'builtin' };
export const MIGRATION_GATE: GatePlanEntry = { gateId: 'migration-readiness', kind: 'custom', required: true, command: 'builtin:migration-readiness', source: 'builtin' };
