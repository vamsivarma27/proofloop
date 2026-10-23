/** One source for the system-design questions: the planner, the audit report and the reviewer step all use it. */
export const DESIGN_CHECKLIST: ReadonlyArray<{ area: string; ask: string }> = [
  { area: 'capacity', ask: 'What is the expected user count and peak requests per second, and which latency (p95/p99) and error-rate targets apply? Is there a load test that proves them?' },
  { area: 'data-access', ask: 'Are queries bounded and paginated, indexed for their filters and sorts, free of N+1 patterns, and run with sensible transaction scope?' },
  { area: 'caching', ask: 'Which reads are hot enough to cache, what are the keys, TTL and invalidation, and what happens on a cold cache or stampede?' },
  { area: 'concurrency', ask: 'Are writes idempotent, are races and double submits handled (locks, unique constraints, optimistic versions), and is shared state avoided in process memory?' },
  { area: 'resilience', ask: 'Do outbound calls have timeouts, bounded retries with backoff and jitter, circuit breaking, and does overload shed load (backpressure, rate limits) instead of queueing forever?' },
  { area: 'scalability', ask: 'Can the service run as N stateless instances behind a load balancer, with long work moved to queues or workers and connection pools sized for N instances?' },
  { area: 'failure-modes', ask: 'What happens when the database, cache, queue or a dependency is slow or down, and when a deploy or migration runs mid-traffic?' },
  { area: 'observability', ask: 'Are latency percentiles, error rates, saturation and slow queries measured, with logs that carry a request id and no secrets or PII?' },
];

export const DESIGN_AREAS = DESIGN_CHECKLIST.map((c) => c.area) as [string, ...string[]];

export const renderChecklist = (): string => DESIGN_CHECKLIST.map((c) => `- ${c.area}: ${c.ask}`).join('\n');
