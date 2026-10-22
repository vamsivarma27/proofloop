import { z } from 'zod';

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const riskRank = (r: RiskLevel): number => RISK_LEVELS.indexOf(r);

export const PHASE_IDS = [
  'intake',
  'clarify',
  'reconnaissance',
  'impact',
  'plan',
  'approval',
  'implementation',
  'verification',
  'repair',
  'review',
  'delivery',
  'retrospective',
] as const;
export type PhaseId = (typeof PHASE_IDS)[number];

/** Phases no protocol may omit, whatever the agent says (PRD 9.1). */
export const UNSKIPPABLE_PHASES: readonly PhaseId[] = ['verification', 'delivery'];

export const GATE_KINDS = [
  'format',
  'lint',
  'typecheck',
  'unit',
  'build',
  'integration',
  'browser',
  'security-scan',
  'migration',
  'performance',
  'load',
  'custom',
] as const;
export type GateKind = (typeof GATE_KINDS)[number];

const kebab = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'must be kebab-case');
const semver = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'must be semver, e.g. 1.0.0');

const gate = z.strictObject({
  id: kebab,
  kind: z.enum(GATE_KINDS),
  required: z.boolean(),
  /** Gate is part of the plan only when task risk is at least this level. */
  minRisk: z.enum(RISK_LEVELS).default('low'),
  description: z.string().optional(),
});

const phase = z.strictObject({
  id: z.enum(PHASE_IDS),
  title: z.string().min(1),
  skipped: z.strictObject({ reason: z.string().min(10, 'give a real reason for skipping') }).optional(),
  requiredArtifacts: z.array(z.string()).default([]),
  gates: z.array(kebab).default([]),
});

export const protocolSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: kebab,
    version: semver,
    title: z.string().min(1),
    description: z.string().min(1),
    /** Minimum engine version that can run this protocol, e.g. ">=0.7.0". */
    engine: z.string().regex(/^>=\d+\.\d+\.\d+$/, 'must look like ">=0.7.0"'),
    mode: z.enum(['existing-repo', 'idea-to-product']),
    defaultRisk: z.enum(RISK_LEVELS),
    retry: z
      .strictObject({
        maxRepairAttempts: z.number().int().min(0).max(10).default(3),
        stopOnIdenticalFailure: z.boolean().default(true),
      })
      .default({ maxRepairAttempts: 3, stopOnIdenticalFailure: true }),
    requiredArtifacts: z.array(z.string()).default([]),
    personas: z.array(kebab).default([]),
    gates: z.array(gate).default([]),
    phases: z.array(phase).min(1),
  })
  .superRefine((p, ctx) => {
    const gateIds = new Set<string>();
    p.gates.forEach((g, i) => {
      if (gateIds.has(g.id)) ctx.addIssue({ code: 'custom', path: ['gates', i, 'id'], message: `duplicate gate id "${g.id}"` });
      gateIds.add(g.id);
    });
    const phaseIds = new Set<string>();
    p.phases.forEach((ph, i) => {
      if (phaseIds.has(ph.id)) ctx.addIssue({ code: 'custom', path: ['phases', i, 'id'], message: `duplicate phase "${ph.id}"` });
      phaseIds.add(ph.id);
      if (ph.skipped && UNSKIPPABLE_PHASES.includes(ph.id))
        ctx.addIssue({ code: 'custom', path: ['phases', i, 'skipped'], message: `phase "${ph.id}" can never be skipped` });
      ph.gates.forEach((g, j) => {
        if (!gateIds.has(g)) ctx.addIssue({ code: 'custom', path: ['phases', i, 'gates', j], message: `unknown gate "${g}"; declare it under gates` });
      });
    });
    for (const required of UNSKIPPABLE_PHASES) {
      if (!phaseIds.has(required)) ctx.addIssue({ code: 'custom', path: ['phases'], message: `missing required phase "${required}"` });
    }
    if (riskRank(p.defaultRisk) >= riskRank('high') && !p.phases.some((ph) => ph.id === 'review' && !ph.skipped))
      ctx.addIssue({ code: 'custom', path: ['phases'], message: 'high/critical protocols must include an unskipped "review" phase' });
    if (p.mode === 'existing-repo' && !p.gates.some((g) => g.required))
      ctx.addIssue({ code: 'custom', path: ['gates'], message: 'existing-repo protocols need at least one required gate' });
  });

export type Protocol = z.infer<typeof protocolSchema>;
export type ProtocolGate = Protocol['gates'][number];
