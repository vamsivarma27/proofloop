import type { Blueprint } from './schema';
import { assumptionsVisible } from './schema';

const bullets = (xs: readonly string[]): string => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- none');

export function renderBlueprintMarkdown(bp: Blueprint, hash: string, needsConfirmation: readonly string[]): string {
  const L: string[] = [`# Product blueprint (\`${hash.slice(0, 12)}\`)`, '', `**Idea:** ${bp.idea.oneLine}`, '', `**Outcome:** ${bp.idea.outcome}`, ''];
  L.push('## Needs your confirmation', bullets(needsConfirmation), '');
  L.push('## Facts (user-provided or cited)', bullets(bp.facts.map((f) => `${f.id} [${f.source}] ${f.text}${f.findingId ? ` (${f.findingId})` : ''}`)), '');
  L.push('## Assumptions', bullets(bp.assumptions.map((a) => `${a.id} [${a.impact}] ${a.status}: ${a.text}`)), '');
  L.push('## Recommendations', bullets(bp.recommendations.map((r) => `${r.id}: ${r.text} — ${r.rationale} (basis: ${r.basedOn.join(', ')})`)), '');
  L.push('## Research (URL, date consulted)', bullets(bp.research.map((r) => `${r.id} [${r.confidence}] ${r.claim} — ${r.url} (consulted ${r.consultedAt})`)), '');
  L.push('## Personas', bullets(bp.personas.map((p) => `${p.name}: ${p.goals.join('; ')}`)), '', '## Journeys', bullets(bp.journeys.map((j) => `${j.name} (${j.personaId}): ${j.steps.join(' → ')}`)), '');
  L.push('## Features', bullets(bp.features.map((f) => `${f.id} ${f.mvp ? '**MVP**' : 'later'} ${f.name}: ${f.description}`)), '', '## Success metrics', bullets(bp.successMetrics.map((m) => `${m.metric}: ${m.target} (measured by ${m.measurement})`)), '');
  L.push('## Architecture and stack (with trade-offs)');
  for (const s of bp.architecture.stack) L.push(`- **${s.area}: ${s.choice}** — ${s.tradeoffs}\n  - alternatives: ${s.alternatives.map((a) => `${a.name} (${a.tradeoff})`).join('; ')}\n  - satisfies: ${s.satisfies.join(', ')}`);
  L.push('', `Security model: ${bp.architecture.securityModel}`, `Operations: ${bp.architecture.operational}`, '', '### Capacity (stated targets, not guarantees)', bullets(bp.architecture.capacity.targets.map((t) => `${t.metric}: ${t.target}`)), '');
  L.push('## Risk register', bullets(bp.risks.map((r) => `${r.id} (${r.likelihood}/${r.impact}) ${r.text} — mitigation: ${r.mitigation}`)), '');
  L.push('## Roadmap');
  for (const m of bp.roadmap.milestones) L.push(`- **${m.id} ${m.title}** (depends on: ${m.dependencies.join(', ') || 'none'}) — ${m.goal}\n  - features: ${m.featureIds.join(', ')}\n  - verification: ${m.verification}${m.assumptionIds.length ? `\n  - rests on assumptions: ${m.assumptionIds.join(', ')}` : ''}`);
  const hidden = assumptionsVisible(bp);
  if (hidden.length) L.push('', `**Warning:** high-impact assumptions not surfaced for confirmation: ${hidden.join(', ')}`);
  return `${L.join('\n')}\n`;
}

export function renderAdr(n: number, s: Blueprint['architecture']['stack'][number]): { path: string; content: string } {
  const slug = `${s.area}-${s.choice}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const num = String(n).padStart(4, '0');
  return {
    path: `docs/decisions/${num}-${slug}.md`,
    content: `# ${num}. ${s.area}: ${s.choice}\n\nStatus: proposed (accepted when the blueprint is approved)\n\n## Context\nRequirements addressed: ${s.satisfies.join(', ')}.\n\n## Decision\nUse ${s.choice} for ${s.area}.\n\n## Alternatives considered\n${s.alternatives.map((a) => `- ${a.name}: ${a.tradeoff}`).join('\n')}\n\n## Consequences\n${s.tradeoffs}\n`,
  };
}

export function blueprintDocs(bp: Blueprint, hash: string, needs: readonly string[]): Array<{ path: string; content: string }> {
  return [
    { path: 'docs/product/blueprint.md', content: renderBlueprintMarkdown(bp, hash, needs) },
    { path: 'docs/product/roadmap.md', content: `# Roadmap\n\n${bp.roadmap.milestones.map((m) => `## ${m.id} ${m.title}\n${m.goal}\n\nDepends on: ${m.dependencies.join(', ') || 'none'}\n\nAcceptance criteria:\n${bullets(m.acceptanceCriteria)}\n\nVerification: ${m.verification}\n`).join('\n')}` },
    ...bp.architecture.stack.map((s, i) => renderAdr(i + 1, s)),
  ];
}
