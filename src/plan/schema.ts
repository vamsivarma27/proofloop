import { z } from 'zod';
import { RISK_LEVELS, type RiskLevel, riskRank } from '../protocol/schema';
import { classifyRisk } from '../policy/risk';
import { scopesOverlap } from '../policy/paths';
import { transitiveDeps, topoSort } from './dag';
import { DESIGN_AREAS } from '../audit/checklist';

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-?[A-Za-z0-9_.-]+$`), `must start with "${prefix}"`);

export const planSchema = z.strictObject({
  schemaVersion: z.literal(1),
  intent: z.strictObject({
    summary: z.string().min(5),
    outcome: z.string().min(5),
    constraints: z.array(z.string()).default([]),
    nonGoals: z.array(z.string()).default([]),
  }),
  assumptions: z.array(z.strictObject({ id: id('A'), text: z.string().min(3), impact: z.enum(RISK_LEVELS), confirmed: z.boolean() })).default([]),
  affectedModules: z.array(z.strictObject({ path: z.string().min(1), reason: z.string().min(3), status: z.enum(['confirmed', 'hypothesis']) })).min(1),
  acceptanceCriteria: z
    .array(
      z.strictObject({
        id: id('AC'),
        text: z.string().min(5),
        tests: z.array(z.string().min(1)).default([]),
        manual: z.strictObject({ reason: z.string().min(5) }).optional(),
      }),
    )
    .min(1),
  testPlan: z.array(z.strictObject({ id: id('T'), kind: z.string().min(2), description: z.string().min(3), gateId: z.string().optional() })).min(1),
  risk: z.strictObject({ level: z.enum(RISK_LEVELS), rationale: z.string().min(5) }),
  tasks: z
    .array(
      z.strictObject({
        id: id('task'),
        title: z.string().min(3),
        description: z.string().min(3),
        dependencies: z.array(z.string()).default([]),
        fileScopes: z.array(z.string()).min(1),
        acceptanceCriteria: z.array(z.string()).min(1),
        risk: z.enum(RISK_LEVELS).default('low'),
        contract: z.string().optional(),
        doneWhen: z.string().min(3),
      }),
    )
    .min(1),
  /** System-design intent: expected scale, latency targets, and the decisions that serve them. Optional, but a stated scale needs a load or performance check. */
  design: z
    .strictObject({
      scale: z.strictObject({ expectedUsers: z.number().int().positive(), peakRps: z.number().positive().optional(), targets: z.strictObject({ p95Ms: z.number().positive(), p99Ms: z.number().positive(), errorRate: z.number().min(0).max(1) }) }),
      decisions: z.array(z.strictObject({ area: z.enum(DESIGN_AREAS), decision: z.string().min(5), tradeoff: z.string().optional() })).default([]),
    })
    .optional(),
  /** Commands the human approves with the plan; each still passes command policy at run time. */
  gateCommands: z.record(z.string(), z.string()).default({}),
  reproduction: z.strictObject({ steps: z.string(), observed: z.string(), expected: z.string(), reproducible: z.enum(['yes', 'no', 'unknown']) }).optional(),
  regressionTest: z.strictObject({ file: z.string(), command: z.string() }).optional(),
  rootCause: z.strictObject({ hypotheses: z.array(z.string().min(3)).min(1), confirmed: z.string().min(3).optional(), uncertainty: z.string().min(3).optional() }).optional(),
});

export type Plan = z.infer<typeof planSchema>;

export interface PlanValidation {
  plan?: Plan;
  errors: string[];
  warnings: string[];
  effectiveRisk?: RiskLevel;
}

const dup = (ids: string[]): string[] => ids.filter((x, i) => ids.indexOf(x) !== i);

/** Structure + semantics. Never trusts the agent's own risk rating or coverage claims. */
export function validatePlan(input: unknown, opts: { protocolId?: string } = {}): PlanValidation {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`), warnings: [] };
  const plan = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const d of new Set([...dup(plan.acceptanceCriteria.map((a) => a.id)), ...dup(plan.tasks.map((t) => t.id)), ...dup(plan.testPlan.map((t) => t.id))])) errors.push(`duplicate id "${d}"`);

  const acIds = new Set(plan.acceptanceCriteria.map((a) => a.id));
  for (const ac of plan.acceptanceCriteria)
    if (ac.tests.length === 0 && !ac.manual) errors.push(`${ac.id} has no executable test and no documented manual check`);
  for (const t of plan.tasks) for (const a of t.acceptanceCriteria) if (!acIds.has(a)) errors.push(`${t.id} references unknown criterion ${a}`);
  const covered = new Set(plan.tasks.flatMap((t) => t.acceptanceCriteria));
  for (const ac of acIds) if (!covered.has(ac)) errors.push(`${ac} is not covered by any task`);

  try {
    topoSort(plan.tasks);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  const floor = classifyRisk(plan.affectedModules.map((m) => m.path));
  if (riskRank(plan.risk.level) < riskRank(floor)) errors.push(`plan risk "${plan.risk.level}" is below the engine-computed minimum "${floor}" for the affected paths; agents cannot lower risk`);
  if (opts.protocolId === 'bug' && !plan.regressionTest) errors.push('bug plans need a regressionTest (file + command)');
  if (opts.protocolId === 'bug' && !plan.reproduction) errors.push('bug plans need a reproduction record (reproducible: yes|no|unknown)');
  if (opts.protocolId === 'bug' && !(plan.rootCause?.confirmed || plan.rootCause?.uncertainty)) errors.push('bug plans need a rootCause with a confirmed cause or an explicit uncertainty');

  const MEASURING = /load|perf|bench|latency|stress/i;
  if (plan.design && !plan.testPlan.some((t) => MEASURING.test(t.kind) || MEASURING.test(t.gateId ?? ''))) errors.push('design.scale states targets but the test plan has no load/performance check that could prove them');
  if (!plan.design && riskRank(plan.risk.level) >= riskRank('medium') && opts.protocolId !== 'bug') warnings.push('no design section: expected scale, latency targets and design decisions were not considered');

  if (errors.length === 0) {
    for (let i = 0; i < plan.tasks.length; i++)
      for (let j = i + 1; j < plan.tasks.length; j++) {
        const [a, b] = [plan.tasks[i]!, plan.tasks[j]!];
        const ordered = transitiveDeps(plan.tasks, a.id).has(b.id) || transitiveDeps(plan.tasks, b.id).has(a.id);
        if (!ordered && scopesOverlap(a.fileScopes, b.fileScopes)) warnings.push(`${a.id} and ${b.id} overlap on files but are not ordered; they will run sequentially, not in parallel`);
      }
    for (const m of plan.affectedModules) if (m.status === 'hypothesis') warnings.push(`${m.path} is a hypothesis, not a confirmed impact`);
    for (const a of plan.assumptions) if (!a.confirmed && riskRank(a.impact) >= riskRank('high')) warnings.push(`high-impact assumption ${a.id} is unconfirmed`);
  }
  const effectiveRisk = riskRank(plan.risk.level) >= riskRank(floor) ? plan.risk.level : floor;
  return { plan: errors.length === 0 ? plan : undefined, errors, warnings, effectiveRisk };
}

export function renderPlanMarkdown(plan: Plan, hash: string, version: number): string {
  const L: string[] = [];
  L.push(`# Plan v${version} (\`${hash.slice(0, 12)}\`)`, '', `**Intent:** ${plan.intent.summary}`, '', `**Outcome:** ${plan.intent.outcome}`, '');
  const gates = Object.keys(plan.gateCommands).length;
  L.push('## At a glance', '', '| Risk | Tasks | Acceptance criteria | Files in scope | Commands to approve |', '|---|---|---|---|---|', `| ${plan.risk.level} | ${plan.tasks.length} | ${plan.acceptanceCriteria.length} | ${plan.affectedModules.length} | ${gates} |`, '');
  if (plan.intent.nonGoals.length) L.push('**Non-goals:**', ...plan.intent.nonGoals.map((x) => `- ${x}`), '');
  L.push(`**Risk:** ${plan.risk.level} — ${plan.risk.rationale}`, '', '## Assumptions');
  L.push(...(plan.assumptions.length ? plan.assumptions.map((a) => `- ${a.id} [${a.impact}] ${a.confirmed ? 'confirmed' : '**unconfirmed**'}: ${a.text}`) : ['- none']), '', '## Affected modules');
  L.push(...plan.affectedModules.map((m) => `- \`${m.path}\` (${m.status}) — ${m.reason}`), '', '## Acceptance criteria');
  L.push(...plan.acceptanceCriteria.map((a) => `- ${a.id}: ${a.text}\n  - verified by: ${a.tests.length ? a.tests.map((t) => `\`${t}\``).join(', ') : `manual (${a.manual?.reason})`}`), '', '## Test plan');
  L.push(...plan.testPlan.map((t) => `- ${t.id} [${t.kind}] ${t.description}${t.gateId ? ` → gate \`${t.gateId}\`` : ''}`), '', '## Tasks');
  L.push(...plan.tasks.map((t) => `- **${t.id}** ${t.title} (risk ${t.risk}) deps: ${t.dependencies.join(', ') || 'none'}; scope: ${t.fileScopes.join(', ')}; covers ${t.acceptanceCriteria.join(', ')}; done when: ${t.doneWhen}`));
  if (plan.design) {
    const { scale: sc, decisions } = plan.design;
    L.push('', '## Design and scale', `- Expected: ${sc.expectedUsers} users${sc.peakRps ? `, ~${sc.peakRps} rps peak` : ''}; targets p95 <= ${sc.targets.p95Ms} ms, p99 <= ${sc.targets.p99Ms} ms, errors <= ${sc.targets.errorRate * 100}%`, ...decisions.map((x) => `- ${x.area}: ${x.decision}${x.tradeoff ? ` (trade-off: ${x.tradeoff})` : ''}`));
  }
  if (Object.keys(plan.gateCommands).length) L.push('', '## Commands approved with this plan', ...Object.entries(plan.gateCommands).map(([g, c]) => `- ${g}: \`${c}\``));
  L.push('', '## What happens next', '1. You review this plan. Approval binds to the hash above; any change to the plan needs a new approval.', '2. Tasks run in an isolated worktree, in dependency order.', '3. Every acceptance criterion is checked by the gates on the final commit. Anything not proven is reported as such.');
  return `${L.join('\n')}\n`;
}
