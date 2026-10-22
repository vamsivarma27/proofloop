/* One-off: creates the parent issue and one child per release through ProofLoop's own GitHub adapter (idempotent). */
import { writeFileSync } from 'node:fs';
import { GhAdapter } from '../src/github/adapter';

const repo = process.argv[2] ?? 'vamsivarma27/proofloop';
const gh = new GhAdapter(repo);
const pre = await gh.preflight();
if (!pre.ok) throw new Error(pre.problems.join('; '));

const releases = [
  ['v0.1', 'Core harness and repository workflows', 'State machine, policy, gates, evidence, GitHub sync, plan approval, feature/bug protocols, plugin packaging.'],
  ['v0.2', 'Idea-to-Product discovery and GitHub roadmap', 'Interview tracking, cited research, blueprint validation and approval, roadmap issues, ADR/spec templates.'],
  ['v0.3', 'Durable autonomous execution and safe parallel workers', 'Leases, worktree-per-task, scope-aware scheduling, integration, failure classifier, cancellation.'],
  ['v0.4', 'Evidence-driven QA and browser personas', 'App lifecycle, personas, traces, AC traceability, BLOCKED on environment failures, test-integrity.'],
  ['v0.5', 'Code Mode and composable tool execution', 'ToolComposer, typed tools, Node-permission sandbox, disabled Cloudflare adapter, benchmark.'],
  ['v0.6', 'Production-readiness and performance protocols', 'Performance evidence rules, query plans, artifacts, migration readiness, production guard.'],
  ['v0.7', 'Protocol SDK and contribution ecosystem', 'Example protocols, validation diagnostics, adapter contract kit, pinned versions.'],
] as const;

const labels = ['feature', 'release-candidate'];
const parent = await gh.ensureIssue('bootstrap/parent', 'ProofLoop 1.0.0-rc.1: build v0.1 through v1.0 from the PRD', 'Parent issue for the first complete build. Scope and acceptance mapping: docs/plans/release-status.md. Open items before 1.0.0: CI results on the PR, license decision, independent security review, real-model evaluation.', labels, '1');
const out: Record<string, { number: number; url: string }> = { parent: { number: parent.number, url: parent.url } };
for (const [id, title, body] of releases) {
  const child = await gh.ensureIssue(`bootstrap/${id}`, `${id}: ${title}`, `${body}\n\nAcceptance criteria and evidence: docs/plans/release-status.md#${id.replace('.', '')}`, labels, '1');
  await gh.linkSubIssue(parent, child);
  out[id] = { number: child.number, url: child.url };
}
writeFileSync('docs/plans/issue-map.json', `${JSON.stringify(out, null, 2)}\n`);
process.stderr.write(`${JSON.stringify(out)}\n`);
