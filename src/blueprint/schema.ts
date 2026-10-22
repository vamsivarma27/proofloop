import { z } from 'zod';
import { RISK_LEVELS } from '../protocol/schema';
import { topoSort } from '../plan/dag';

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, 'ids start with a letter and use letters, digits, _ . -');
const text = z.string().min(3);

export const researchFinding = z.strictObject({
  id,
  claim: text,
  url: z.string(),
  consultedAt: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  sourceType: z.enum(['vendor-docs', 'standard', 'open-source', 'article', 'community', 'other']).default('other'),
});

const requirement = z.strictObject({ id, text, kind: z.enum(['functional', 'nfr', 'integration', 'security', 'capacity']), measurable: z.string().optional() });
const stackChoice = z.strictObject({
  id,
  area: z.string().min(2),
  choice: z.string().min(1),
  alternatives: z.array(z.strictObject({ name: z.string().min(1), tradeoff: text })).min(1),
  tradeoffs: text,
  satisfies: z.array(id).min(1),
  citations: z.array(id).default([]),
});

export const blueprintSchema = z.strictObject({
  schemaVersion: z.literal(1),
  idea: z.strictObject({ oneLine: text, outcome: text }),
  facts: z.array(z.strictObject({ id, text, source: z.enum(['user', 'research']), findingId: id.optional() })).default([]),
  assumptions: z.array(z.strictObject({ id, text, impact: z.enum(RISK_LEVELS), status: z.enum(['unconfirmed', 'confirmed']), needsConfirmation: z.boolean() })).default([]),
  recommendations: z.array(z.strictObject({ id, text, rationale: text, basedOn: z.array(id).min(1) })).default([]),
  research: z.array(researchFinding).default([]),
  personas: z.array(z.strictObject({ id, name: z.string().min(2), goals: z.array(text).min(1), painPoints: z.array(text).default([]) })).min(1),
  journeys: z.array(z.strictObject({ id, personaId: id, name: z.string().min(2), steps: z.array(text).min(1) })).default([]),
  requirements: z.array(requirement).min(1),
  features: z.array(z.strictObject({ id, name: z.string().min(2), description: text, mvp: z.boolean(), personaIds: z.array(id).min(1), requirementIds: z.array(id).min(1) })).min(1),
  successMetrics: z.array(z.strictObject({ id, metric: text, target: z.string().min(1), measurement: text })).min(1),
  architecture: z.strictObject({
    stack: z.array(stackChoice).min(1),
    dataModel: z.array(z.strictObject({ entity: z.string().min(1), fields: z.array(z.string()).min(1) })).default([]),
    apiBoundaries: z.array(text).default([]),
    integrations: z.array(z.strictObject({ name: z.string().min(1), purpose: text, risk: text })).default([]),
    securityModel: text,
    operational: text,
    capacity: z.strictObject({ assumptions: z.array(text).min(1), targets: z.array(z.strictObject({ metric: z.string().min(1), target: z.string().min(1) })).min(1) }),
  }),
  risks: z.array(z.strictObject({ id, text, likelihood: z.enum(RISK_LEVELS), impact: z.enum(RISK_LEVELS), mitigation: text })).min(1),
  roadmap: z.strictObject({
    milestones: z.array(z.strictObject({ id, title: z.string().min(3), goal: text, dependencies: z.array(id).default([]), featureIds: z.array(id).min(1), acceptanceCriteria: z.array(text).min(1), verification: text, assumptionIds: z.array(id).default([]) })).min(1),
  }),
  openDecisions: z.array(z.strictObject({ id, question: text, defaultChoice: text, impact: z.enum(RISK_LEVELS), relatedAssumptionIds: z.array(id).default([]) })).default([]),
});
export type Blueprint = z.infer<typeof blueprintSchema>;

export interface BlueprintValidation {
  blueprint?: Blueprint;
  errors: string[];
  warnings: string[];
  /** Everything the human must confirm: unconfirmed assumptions and open decisions (v0.2 AC7). */
  needsConfirmation: string[];
  /** Claims not backed by a cited, dated source. */
  unsupported: string[];
}

const OVERCLAIM = /\b(unlimited (scal|capacity|users|throughput)|infinite(ly)? scal|zero bugs|bug[- ]free|100% uptime|never (fails|goes down)|guaranteed (to scale|uptime))/i;
const MARKET_CLAIM = /\b(market[- ]validated|validated (by|in) the market|proven demand|customers (want|need) this)\b/i;

function dupIds(label: string, ids: string[], errors: string[]): void {
  for (const d of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) errors.push(`duplicate ${label} id "${d}"`);
}

function checkResearch(bp: Blueprint, errors: string[], unsupported: string[]): Set<string> {
  const valid = new Set<string>();
  for (const f of bp.research) {
    let ok = true;
    try {
      const u = new URL(f.url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    } catch {
      errors.push(`research ${f.id}: "${f.url}" is not a valid http(s) URL`);
      ok = false;
    }
    const t = Date.parse(f.consultedAt);
    if (Number.isNaN(t)) {
      errors.push(`research ${f.id}: consultedAt must be an ISO timestamp`);
      ok = false;
    } else if (t > Date.now() + 86_400_000) {
      errors.push(`research ${f.id}: consultedAt is in the future`);
      ok = false;
    }
    if (ok) valid.add(f.id);
    else unsupported.push(f.claim);
  }
  return valid;
}

function checkEvidenceLinks(bp: Blueprint, valid: Set<string>, refs: Set<string>, errors: string[], unsupported: string[]): void {
  for (const f of bp.facts) {
    if (f.source === 'research' && !(f.findingId && valid.has(f.findingId))) {
      errors.push(`fact ${f.id} claims research support without a valid cited finding; relabel it as an assumption`);
      unsupported.push(f.text);
    }
  }
  const known = new Set([...bp.facts.map((x) => x.id), ...bp.assumptions.map((x) => x.id), ...bp.research.map((x) => x.id)]);
  for (const r of bp.recommendations) for (const b of r.basedOn) if (!known.has(b)) errors.push(`recommendation ${r.id} is based on unknown "${b}"`);
  for (const s of bp.architecture.stack) for (const c of s.citations) if (!valid.has(c)) errors.push(`stack ${s.id} cites unknown or invalid research "${c}"`);
  void refs;
}

function checkTraceability(bp: Blueprint, errors: string[], warnings: string[]): void {
  const reqs = new Set(bp.requirements.map((r) => r.id));
  const personas = new Set(bp.personas.map((p) => p.id));
  const features = new Set(bp.features.map((f) => f.id));
  for (const f of bp.features) {
    for (const r of f.requirementIds) if (!reqs.has(r)) errors.push(`feature ${f.id} references unknown requirement ${r}`);
    for (const p of f.personaIds) if (!personas.has(p)) errors.push(`feature ${f.id} references unknown persona ${p}`);
  }
  for (const j of bp.journeys) if (!personas.has(j.personaId)) errors.push(`journey ${j.id} references unknown persona ${j.personaId}`);
  const covered = new Set(bp.features.flatMap((f) => f.requirementIds));
  for (const r of bp.requirements.filter((x) => x.kind === 'functional')) if (!covered.has(r.id)) errors.push(`functional requirement ${r.id} is not delivered by any feature`);
  const stackSat = new Set(bp.architecture.stack.flatMap((s) => s.satisfies));
  for (const s of bp.architecture.stack) for (const r of s.satisfies) if (!reqs.has(r)) errors.push(`stack ${s.id} claims to satisfy unknown requirement ${r}`);
  for (const r of bp.requirements.filter((x) => x.kind !== 'functional')) if (!stackSat.has(r.id)) errors.push(`${r.kind} requirement ${r.id} is not addressed by any stack or architecture choice`);
  const planned = new Set(bp.roadmap.milestones.flatMap((m) => m.featureIds));
  for (const m of bp.roadmap.milestones) for (const f of m.featureIds) if (!features.has(f)) errors.push(`milestone ${m.id} references unknown feature ${f}`);
  for (const f of bp.features.filter((x) => x.mvp)) if (!planned.has(f.id)) errors.push(`MVP feature ${f.id} is not on the roadmap`);
  for (const r of bp.requirements) if (r.kind === 'capacity' && !r.measurable) warnings.push(`capacity requirement ${r.id} has no measurable target; no scalability claim can be made`);
}

function checkRoadmap(bp: Blueprint, errors: string[]): void {
  dupIds('milestone', bp.roadmap.milestones.map((m) => m.id), errors);
  try {
    topoSort(bp.roadmap.milestones);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  const assumptions = new Set(bp.assumptions.map((a) => a.id));
  for (const m of bp.roadmap.milestones) for (const a of m.assumptionIds) if (!assumptions.has(a)) errors.push(`milestone ${m.id} references unknown assumption ${a}`);
}

function checkClaims(bp: Blueprint, errors: string[], warnings: string[]): void {
  const all = JSON.stringify(bp);
  const over = OVERCLAIM.exec(all);
  if (over) errors.push(`overclaim "${over[0]}": ProofLoop blueprints may not promise bug-free software or unlimited capacity; state a measured target instead`);
  if (MARKET_CLAIM.test(all) && !bp.research.some((r) => r.confidence !== 'low')) warnings.push('market-validation language is used but no medium/high-confidence research supports it');
}

export function validateBlueprint(input: unknown): BlueprintValidation {
  const parsed = blueprintSchema.safeParse(input);
  if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`), warnings: [], needsConfirmation: [], unsupported: [] };
  const bp = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  const unsupported: string[] = [];
  dupIds('requirement', bp.requirements.map((x) => x.id), errors);
  dupIds('feature', bp.features.map((x) => x.id), errors);
  dupIds('persona', bp.personas.map((x) => x.id), errors);
  dupIds('fact/assumption/research', [...bp.facts, ...bp.assumptions, ...bp.research].map((x) => x.id), errors);
  const valid = checkResearch(bp, errors, unsupported);
  checkEvidenceLinks(bp, valid, new Set(), errors, unsupported);
  checkTraceability(bp, errors, warnings);
  checkRoadmap(bp, errors);
  checkClaims(bp, errors, warnings);
  const needsConfirmation = [
    ...bp.assumptions.filter((a) => a.status === 'unconfirmed' && (a.needsConfirmation || a.impact === 'high' || a.impact === 'critical')).map((a) => `assumption ${a.id} [${a.impact}]: ${a.text}`),
    ...bp.openDecisions.map((d) => `decision ${d.id} [${d.impact}]: ${d.question} (default: ${d.defaultChoice})`),
  ];
  return { blueprint: errors.length === 0 ? bp : undefined, errors, warnings, needsConfirmation, unsupported };
}

/** Every unconfirmed high-impact assumption must be visible to the approver as a confirm-me item. */
export function assumptionsVisible(bp: Blueprint): string[] {
  const surfaced = new Set([...bp.roadmap.milestones.flatMap((m) => m.assumptionIds), ...bp.openDecisions.flatMap((d) => d.relatedAssumptionIds)]);
  return bp.assumptions.filter((a) => a.status === 'unconfirmed' && (a.impact === 'high' || a.impact === 'critical') && !(a.needsConfirmation && surfaced.has(a.id))).map((a) => a.id);
}
