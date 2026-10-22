import { DatabaseSync } from 'node:sqlite';
import { PlError } from '../shared/errors';

export interface PlanFinding {
  sql: string;
  steps: string[];
  fullScans: string[];
  usesIndex: boolean;
}

/** Port: any database can be supported by implementing this; SQLite ships in the box. */
export interface QueryPlanAdapter {
  readonly name: string;
  inspect(queries: readonly string[]): PlanFinding[];
}

const SELECT_ONLY = /^\s*(select|with)\b/i;

/** Read-only inspection with EXPLAIN QUERY PLAN against a database file opened read-only. Never executes the query. */
export class SqliteQueryPlanAdapter implements QueryPlanAdapter {
  readonly name = 'sqlite';
  constructor(private readonly path: string) {}

  inspect(queries: readonly string[]): PlanFinding[] {
    const db = new DatabaseSync(this.path, { readOnly: true });
    try {
      return queries.map((sql) => {
        if (!SELECT_ONLY.test(sql) || sql.includes(';')) throw new PlError('PL_PERF_001', 'only a single SELECT statement can be inspected');
        const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
        const steps = rows.map((r) => r.detail);
        const fullScans = steps.filter((d) => /^SCAN\b/.test(d) && !/USING (COVERING )?INDEX/.test(d)).map((d) => d.replace(/^SCAN\s+/, ''));
        return { sql, steps, fullScans, usesIndex: steps.some((d) => /USING (COVERING )?INDEX/.test(d)) };
      });
    } finally {
      db.close();
    }
  }
}
