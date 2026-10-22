import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlError } from '../shared/errors';
import { sha256 } from '../shared/hash';
import type { Store } from '../state/store';
import { type Measurement, measurementSchema } from './report';

/** Stores a validated measurement as evidence tied to its commit. Raw numbers only; no interpretation. */
export function recordMeasurement(store: Store, runId: string, input: unknown, artifactDir: string): { evidenceId: string; measurement: Measurement } {
  const parsed = measurementSchema.safeParse(input);
  if (!parsed.success) throw new PlError('PL_PERF_010', `invalid measurement: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const m = parsed.data;
  if (!m.samples && !m.summary) throw new PlError('PL_PERF_011', 'a measurement needs raw samples or a tool summary');
  const dir = join(artifactDir, runId);
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(m, null, 1);
  const uri = join(dir, `perf-${m.phase}-${m.commit.slice(0, 8)}.json`);
  writeFileSync(uri, body);
  const evidenceId = store.addEvidence({ taskRunId: runId, kind: m.phase === 'baseline' ? 'perf-baseline' : 'perf-after', uri, checksum: sha256(body), commitSha: m.commit, environment: `${m.kind}; ${m.environment}`, summary: `${m.phase} ${m.target.metric} ${m.target.comparator} ${m.target.value}${m.target.unit} on ${m.workload.description}`, redactionStatus: 'none-needed' });
  return { evidenceId, measurement: m };
}
