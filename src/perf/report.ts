import { z } from 'zod';

export const MIN_SAMPLES = 30;
export const MIN_IMPROVEMENT = 0.05;

export const measurementSchema = z.strictObject({
  phase: z.enum(['baseline', 'after']),
  /** simulated = synthetic load against a test environment; live-observation = measured in production. Never mixed. */
  kind: z.enum(['simulated', 'live-observation']),
  environment: z.string().min(3),
  workload: z.strictObject({ description: z.string().min(5), dataset: z.string().min(2), concurrency: z.number().int().positive().optional() }),
  target: z.strictObject({ metric: z.enum(['p50', 'p95', 'p99', 'mean', 'errorRate', 'throughput']), comparator: z.enum(['<=', '>=']), value: z.number(), unit: z.enum(['ms', 'rps', 'ratio']) }),
  commit: z.string().min(7),
  capturedAt: z.string(),
  /** Raw samples (preferred) or a tool-provided summary (e.g. k6) with its own sample count. */
  samples: z.array(z.number().finite()).optional(),
  summary: z.strictObject({ n: z.number().int().positive(), p50: z.number().optional(), p95: z.number().optional(), p99: z.number().optional(), mean: z.number().optional(), errorRate: z.number().optional(), throughput: z.number().optional() }).optional(),
});
export type Measurement = z.infer<typeof measurementSchema>;

export interface Stats {
  n: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

const rank = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;

export function summarize(samples: readonly number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  return { n: s.length, min: s[0]!, max: s.at(-1)!, mean: s.reduce((a, b) => a + b, 0) / s.length, p50: rank(s, 50), p95: rank(s, 95), p99: rank(s, 99) };
}

export function metricOf(m: Measurement): number | null {
  const metric = m.target.metric;
  if (m.samples && m.samples.length > 0 && metric !== 'errorRate' && metric !== 'throughput') return summarize(m.samples)[metric];
  return m.summary?.[metric] ?? null;
}

export const sampleCount = (m: Measurement): number => m.samples?.length ?? m.summary?.n ?? 0;

export type Verdict =
  | { kind: 'TARGET_MET'; baseline: number; after: number; improvement: number }
  | { kind: 'TARGET_NOT_MET'; baseline: number; after: number; improvement: number }
  | { kind: 'NO_SIGNIFICANT_CHANGE'; baseline: number; after: number; improvement: number }
  | { kind: 'REGRESSION'; baseline: number; after: number; improvement: number }
  | { kind: 'INVALID'; reason: string };

const better = (cmp: '<=' | '>=', from: number, to: number): number => (cmp === '<=' ? (from - to) / from : (to - from) / from);

/**
 * "Faster" is only claimable with a stated workload and target, the same workload before and after, enough samples,
 * and a change larger than MIN_IMPROVEMENT. Anything else is INVALID or NO_SIGNIFICANT_CHANGE, never a success.
 */
export function evaluatePerformance(baseline: Measurement | undefined, after: Measurement | undefined, minSamples = MIN_SAMPLES): Verdict {
  if (!baseline) return { kind: 'INVALID', reason: 'no baseline: measure before optimizing' };
  if (!after) return { kind: 'INVALID', reason: 'no after-change measurement' };
  if (JSON.stringify(baseline.workload) !== JSON.stringify(after.workload)) return { kind: 'INVALID', reason: 'workload differs between baseline and after; the comparison is not valid' };
  if (JSON.stringify(baseline.target) !== JSON.stringify(after.target)) return { kind: 'INVALID', reason: 'target differs between baseline and after' };
  if (baseline.kind !== after.kind) return { kind: 'INVALID', reason: `cannot compare ${baseline.kind} with ${after.kind} measurements` };
  if (baseline.environment !== after.environment) return { kind: 'INVALID', reason: `environment differs (${baseline.environment} vs ${after.environment})` };
  for (const [label, m] of [['baseline', baseline], ['after', after]] as const) if (sampleCount(m) < minSamples) return { kind: 'INVALID', reason: `${label} has ${sampleCount(m)} samples; at least ${minSamples} are required (one run proves nothing)` };
  const b = metricOf(baseline);
  const a = metricOf(after);
  if (b === null || a === null || b === 0) return { kind: 'INVALID', reason: `metric ${baseline.target.metric} is not available in the recorded data` };
  const baselineMet = after.target.comparator === '<=' ? b <= after.target.value : b >= after.target.value;
  if (baselineMet) return { kind: 'INVALID', reason: `the baseline (${b.toFixed(1)}) already meets the target (${after.target.comparator} ${after.target.value}); an optimization cannot be credited with meeting it. Choose a stricter target or a different problem` };
  const improvement = better(after.target.comparator, b, a);
  const met = after.target.comparator === '<=' ? a <= after.target.value : a >= after.target.value;
  const base = { baseline: b, after: a, improvement };
  if (improvement < -MIN_IMPROVEMENT) return { kind: 'REGRESSION', ...base };
  if (improvement < MIN_IMPROVEMENT) return { kind: 'NO_SIGNIFICANT_CHANGE', ...base };
  return { kind: met ? 'TARGET_MET' : 'TARGET_NOT_MET', ...base };
}

/** Converts a k6 `--summary-export` JSON into a Measurement (summary form). */
export function fromK6Summary(json: unknown, ctx: Pick<Measurement, 'phase' | 'environment' | 'workload' | 'target' | 'commit' | 'capturedAt'>): Measurement {
  const m = (json as { metrics?: Record<string, Record<string, number>> }).metrics ?? {};
  const dur = m.http_req_duration ?? {};
  const n = m.http_reqs?.count ?? 0;
  return measurementSchema.parse({
    ...ctx,
    kind: 'simulated',
    summary: { n, p50: dur.med, p95: dur['p(95)'], p99: dur['p(99)'], mean: dur.avg, errorRate: m.http_req_failed?.value, throughput: m.http_reqs?.rate },
  });
}

const SCALE_CLAIM = /\b(scales? (to|up to)|handles?|supports?)\s+[\d,.]+\s*(k|m)?\s*(users|rps|requests|concurrent|qps|tps)\b/i;

/** Any scalability statement must be backed by a stated target that a measurement actually met. */
export function unsupportedScaleClaims(text: string, verdict: Verdict | null): string[] {
  const claims = text.match(new RegExp(SCALE_CLAIM, 'gi')) ?? [];
  return verdict?.kind === 'TARGET_MET' ? [] : claims;
}
