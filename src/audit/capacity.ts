export interface Targets { p95Ms: number; p99Ms: number; errorRate: number }
export const DEFAULT_TARGETS: Targets = { p95Ms: 300, p99Ms: 800, errorRate: 0.01 };

const ACTIVE_SHARE = 0.1;
const SECONDS_BETWEEN_REQUESTS = 10;
const BURST_FACTOR = 3;

export interface Capacity { users: number; concurrentUsers: number; avgRps: number; peakRps: number; inFlight: number; assumptions: string[] }

/** Back-of-envelope sizing (Little's law). Every number is an assumption the report prints; none is measured. */
export function capacityModel(users: number, p95Ms: number): Capacity {
  const concurrentUsers = Math.ceil(users * ACTIVE_SHARE);
  const avgRps = concurrentUsers / SECONDS_BETWEEN_REQUESTS;
  const peakRps = avgRps * BURST_FACTOR;
  return {
    users, concurrentUsers, avgRps: round(avgRps), peakRps: round(peakRps), inFlight: Math.ceil((peakRps * p95Ms) / 1000),
    assumptions: [`${ACTIVE_SHARE * 100}% of users are active at once`, `each active user sends one request every ${SECONDS_BETWEEN_REQUESTS}s`, `bursts reach ${BURST_FACTOR}x the average`, 'in-flight requests = peak rps x p95 latency (Little\'s law)'],
  };
}

const round = (n: number): number => Math.round(n * 10) / 10;
