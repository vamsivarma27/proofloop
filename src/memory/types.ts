export type IncidentStatus = 'OPEN' | 'INVESTIGATING' | 'ROOT_CAUSE_IDENTIFIED' | 'FIX_IN_PROGRESS' | 'VERIFIED' | 'REOPENED' | 'CLOSED';
export type HypothesisStatus = 'UNVERIFIED' | 'SUPPORTED' | 'REJECTED' | 'CONFIRMED';
export type AttemptOutcome = 'SUCCESS' | 'FAILURE' | 'PARTIAL' | 'ABANDONED';

export interface EvidenceReference {
  type: string;
  description: string;
  url?: string;
  artifactId?: string;
  commitSha?: string;
  recordedAt: string;
}

export interface RootCauseHypothesis {
  id: string;
  description: string;
  status: HypothesisStatus;
  evidence: EvidenceReference[];
}

export interface IncidentAttempt {
  id: string;
  description: string;
  commitSha?: string;
  outcome: AttemptOutcome;
  failureReason?: string;
  diagnosis?: string;
  evidence: EvidenceReference[];
  createdAt: string;
}

export interface RegressionTestReference {
  name: string;
  filePath?: string;
  command?: string;
  lastVerifiedRevision?: string;
  lastResult?: 'PASS' | 'FAIL' | 'UNKNOWN';
}

export interface IncidentRecord {
  id: string;
  taskRunId: string | null;
  repositoryId: string;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  title: string;
  summary: string;
  baseRevision?: string;
  supersedes?: string;
  symptoms: string[];
  expectedBehavior: string[];
  actualBehavior: string[];
  reproductionSteps: string[];
  environment: Record<string, string>;
  rootCauseHypotheses: RootCauseHypothesis[];
  confirmedRootCause?: string;
  attemptedFixes: IncidentAttempt[];
  regressionTests: RegressionTestReference[];
  affectedFiles: string[];
  relatedCommits: string[];
  relatedPullRequests: string[];
  status: IncidentStatus;
  createdAt: string;
  updatedAt: string;
}

export type SourceKind = 'incident' | 'issue' | 'pull-request' | 'decision' | 'regression-test';
export type SourceOutcome = 'ok' | 'failed' | 'skipped';

export interface RelatedIncident {
  incidentId: string;
  title: string;
  summary: string;
  score: number;
  relevanceReason: string;
  rootCause?: string;
  failedApproaches: string[];
  successfulApproach?: string;
  regressionTests: RegressionTestReference[];
  sourceUrls: string[];
  freshness: 'CURRENT' | 'POTENTIALLY_STALE' | 'UNKNOWN';
}

export interface RelatedGithubItem {
  number: number;
  title: string;
  state: string;
  url: string;
  score: number;
  relevanceReason: string;
}

export interface DecisionReference {
  file: string;
  title: string;
}

/** `complete` means every source answered; `partial` means at least one failed; an empty list is only "no history" when complete. */
export interface HistoricalMemoryResult {
  schemaVersion: 1;
  taskId: string;
  repositoryId: string;
  retrievedAt: string;
  retrievedAtRevision: string | null;
  completeness: 'complete' | 'partial' | 'failed';
  sources: Array<{ source: SourceKind; outcome: SourceOutcome; detail?: string }>;
  relatedIncidents: RelatedIncident[];
  relatedIssues: RelatedGithubItem[];
  relatedPullRequests: RelatedGithubItem[];
  relatedRegressionTests: RegressionTestReference[];
  relevantDecisions: DecisionReference[];
  warnings: string[];
}
