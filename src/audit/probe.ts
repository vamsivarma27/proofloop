import { summarize } from '../perf/report';

export interface PathResult { path: string; n: number; errors: number; errorRate: number; p50: number; p95: number; p99: number; rps: number }
export interface ProbeOptions { baseUrl: string; paths: readonly string[]; concurrency: number; requests: number; warmup?: number; timeoutMs?: number; fetchImpl?: typeof fetch }

async function hit(f: typeof fetch, url: string, timeoutMs: number): Promise<{ ms: number; ok: boolean }> {
  const t0 = performance.now();
  try {
    const res = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer();
    return { ms: performance.now() - t0, ok: res.status < 500 };
  } catch {
    return { ms: performance.now() - t0, ok: false };
  }
}

/** A single-machine synthetic probe: N requests per path with bounded concurrency. It measures this app on this machine, not N users. */
export async function probe(o: ProbeOptions): Promise<PathResult[]> {
  const f = o.fetchImpl ?? fetch;
  const results: PathResult[] = [];
  for (const path of o.paths) {
    const url = new URL(path, o.baseUrl).toString();
    for (let i = 0; i < (o.warmup ?? 10); i++) await hit(f, url, o.timeoutMs ?? 10_000);
    const samples: Array<{ ms: number; ok: boolean }> = [];
    let next = 0;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, o.requests)) }, async () => {
      while (next++ < o.requests) samples.push(await hit(f, url, o.timeoutMs ?? 10_000));
    }));
    const s = summarize(samples.map((x) => x.ms));
    const errors = samples.filter((x) => !x.ok).length;
    results.push({ path, n: samples.length, errors, errorRate: errors / samples.length, p50: r(s.p50), p95: r(s.p95), p99: r(s.p99), rps: r((samples.length / (performance.now() - t0)) * 1000) });
  }
  return results;
}

const r = (n: number): number => Math.round(n * 10) / 10;
