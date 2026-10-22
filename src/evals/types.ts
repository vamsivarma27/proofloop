import type { Config } from '../config';
import type { Plan } from '../plan/schema';

export interface AgentCtx {
  cwd: string;
  /** 1-based count of implementer calls in this run (repairs count). */
  attempt: number;
  taskId: string | null;
  isRepair: boolean;
}

export type Category = 'feature' | 'bug' | 'integration' | 'browser' | 'performance' | 'recovery' | 'blocked';

export interface EvalTask {
  id: string;
  category: Category;
  protocol: string;
  intent: string;
  /** What a correct harness does with this task: deliver verified work, or stop without delivering. */
  expect: 'verified' | 'blocked';
  files: Record<string, string>;
  plan: Plan;
  implement: (c: AgentCtx) => void | Promise<void>;
  /** Hidden acceptance, independent of the repository's visible tests. */
  acceptance: (dir: string) => boolean | Promise<boolean>;
  /** Previously-working behaviour that must survive. */
  regression?: (dir: string) => boolean;
  config?: Partial<Config> | ((root: string) => Partial<Config>);
  setup?: (root: string) => void | Promise<void>;
  protocolYaml?: { id: string; yaml: string };
  scenario?: 'crash-mid-run' | 'crash-in-review' | 'performance';
  baselineApplicable?: boolean;
  perf?: { bench: string; methodology: string; profiler: string; hypothesis: string; regressionChecks: string; target: { metric: 'p95'; comparator: '<='; value: number; unit: 'ms' } };
}

export interface TaskOutcome {
  id: string;
  category: Category;
  mode: 'proofloop' | 'baseline';
  expected: 'verified' | 'blocked';
  finalState: string;
  /** Delivered with every required gate PASS on the candidate commit and intact evidence (ProofLoop), or "agent finished" (baseline). */
  delivered: boolean;
  accepted: boolean | null;
  regressed: boolean;
  correct: boolean;
  falseDelivery: boolean;
  repairs: number;
  firstPass: boolean;
  safetyIncidents: number;
  evidenceProblems: number;
  recovered: boolean | null;
  integrationConflicts: number;
  elapsedMs: number;
  notes: string[];
}
