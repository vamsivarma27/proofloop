import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE project (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, repository TEXT, default_branch TEXT,
    created_at_utc TEXT NOT NULL, configuration TEXT NOT NULL DEFAULT '{}', detected_stack TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE task_run (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id),
    protocol_id TEXT NOT NULL, protocol_version TEXT NOT NULL, engine_version TEXT NOT NULL,
    state TEXT NOT NULL, intent TEXT NOT NULL, risk TEXT NOT NULL,
    source_issue_id TEXT, source_issue_number INTEGER,
    plan_version INTEGER NOT NULL DEFAULT 0, current_plan_hash TEXT, approved_plan_hash TEXT,
    base_commit TEXT, head_sha TEXT, active_branch TEXT, worktree_path TEXT,
    repair_count INTEGER NOT NULL DEFAULT 0, repair_budget INTEGER NOT NULL DEFAULT 3,
    pr_url TEXT, blocked_reason TEXT, last_heartbeat_utc TEXT,
    created_at_utc TEXT NOT NULL, updated_at_utc TEXT NOT NULL
  );
  CREATE TABLE plan (
    task_run_id TEXT NOT NULL REFERENCES task_run(id), version INTEGER NOT NULL, hash TEXT NOT NULL,
    body TEXT NOT NULL, created_at_utc TEXT NOT NULL, PRIMARY KEY (task_run_id, version)
  );
  CREATE TABLE step_run (
    id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL REFERENCES task_run(id), step_id TEXT NOT NULL,
    state TEXT NOT NULL, attempt INTEGER NOT NULL, started_at_utc TEXT NOT NULL, finished_at_utc TEXT,
    input_ref TEXT, output_ref TEXT, exit_code INTEGER, error_category TEXT,
    UNIQUE (task_run_id, step_id, attempt)
  );
  CREATE TABLE task_node (
    id TEXT NOT NULL, task_run_id TEXT NOT NULL REFERENCES task_run(id), title TEXT NOT NULL,
    description TEXT NOT NULL, dependencies TEXT NOT NULL DEFAULT '[]', assigned_worker TEXT,
    file_scopes TEXT NOT NULL DEFAULT '[]', acceptance_criteria TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'PENDING', risk_level TEXT NOT NULL DEFAULT 'low', failure_fingerprint TEXT,
    PRIMARY KEY (task_run_id, id)
  );
  CREATE TABLE approval (
    id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL REFERENCES task_run(id), scope TEXT NOT NULL,
    plan_hash TEXT, approved_by TEXT NOT NULL, decision TEXT NOT NULL, comment TEXT, created_at_utc TEXT NOT NULL
  );
  CREATE TABLE gate_plan (
    task_run_id TEXT NOT NULL REFERENCES task_run(id), gate_id TEXT NOT NULL, kind TEXT NOT NULL,
    required INTEGER NOT NULL, command TEXT, PRIMARY KEY (task_run_id, gate_id)
  );
  CREATE TABLE evidence_artifact (
    id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL REFERENCES task_run(id), gate_id TEXT, kind TEXT NOT NULL,
    uri TEXT NOT NULL, checksum TEXT NOT NULL, commit_sha TEXT, environment TEXT NOT NULL,
    created_at_utc TEXT NOT NULL, summary TEXT NOT NULL, redaction_status TEXT NOT NULL
  );
  CREATE TABLE gate_result (
    id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL REFERENCES task_run(id), gate_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PASS','FAIL','BLOCKED')), required INTEGER NOT NULL,
    command_or_assertion TEXT NOT NULL, exit_code INTEGER, evidence_ids TEXT NOT NULL DEFAULT '[]',
    commit_sha TEXT NOT NULL, started_at_utc TEXT NOT NULL, finished_at_utc TEXT NOT NULL,
    failure_category TEXT, fingerprint TEXT, seq INTEGER NOT NULL
  );
  CREATE INDEX gate_result_latest ON gate_result (task_run_id, gate_id, seq);
  CREATE TABLE worker_lease (
    task_node_id TEXT NOT NULL, task_run_id TEXT NOT NULL REFERENCES task_run(id), worker_id TEXT NOT NULL,
    lease_expires_at_utc TEXT NOT NULL, heartbeat_at_utc TEXT NOT NULL, worktree_path TEXT, branch TEXT,
    state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (task_run_id, task_node_id)
  );
  CREATE TABLE event (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_run_id TEXT, ts_utc TEXT NOT NULL, kind TEXT NOT NULL,
    actor TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE idempotency (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at_utc TEXT NOT NULL
  );
  CREATE TABLE sync_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_run_id TEXT, kind TEXT NOT NULL, key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0,
    created_at_utc TEXT NOT NULL
  );
  -- Evidence is append-only at the application level (PRD 14.2); not tamper-proof against a DB owner.
  CREATE TRIGGER evidence_artifact_no_update BEFORE UPDATE ON evidence_artifact BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
  CREATE TRIGGER evidence_artifact_no_delete BEFORE DELETE ON evidence_artifact BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
  CREATE TRIGGER gate_result_no_update BEFORE UPDATE ON gate_result BEGIN SELECT RAISE(ABORT, 'gate results are append-only'); END;
  CREATE TRIGGER gate_result_no_delete BEFORE DELETE ON gate_result BEGIN SELECT RAISE(ABORT, 'gate results are append-only'); END;
  CREATE TRIGGER event_no_update BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
  CREATE TRIGGER event_no_delete BEFORE DELETE ON event BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
  `,
  `
  ALTER TABLE gate_result ADD COLUMN sig TEXT;
  ALTER TABLE approval ADD COLUMN sig TEXT;
  `,
  `
  ALTER TABLE gate_plan ADD COLUMN sig TEXT;
  `,
  `
  CREATE TABLE incident (
    id TEXT PRIMARY KEY, task_run_id TEXT UNIQUE REFERENCES task_run(id), repository TEXT NOT NULL,
    github_issue_number INTEGER, github_issue_url TEXT, title TEXT NOT NULL, summary TEXT NOT NULL,
    base_revision TEXT, supersedes TEXT, created_at_utc TEXT NOT NULL
  );
  CREATE INDEX incident_repository ON incident (repository, created_at_utc);
  -- An incident is its header plus append-only entries; corrections are new entries, never edits.
  CREATE TABLE incident_entry (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL REFERENCES incident(id),
    key TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL, ts_utc TEXT NOT NULL,
    UNIQUE (incident_id, key)
  );
  CREATE TRIGGER incident_entry_no_update BEFORE UPDATE ON incident_entry BEGIN SELECT RAISE(ABORT, 'incident history is append-only'); END;
  CREATE TRIGGER incident_entry_no_delete BEFORE DELETE ON incident_entry BEGIN SELECT RAISE(ABORT, 'incident history is append-only'); END;
  CREATE TRIGGER incident_no_update BEFORE UPDATE ON incident BEGIN SELECT RAISE(ABORT, 'incident headers are immutable'); END;
  CREATE TRIGGER incident_no_delete BEFORE DELETE ON incident BEGIN SELECT RAISE(ABORT, 'incident history is append-only'); END;
  `,
];

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
