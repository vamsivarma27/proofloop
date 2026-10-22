import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PlError } from './shared/errors';

const cmd = z.string().min(1).optional();

export const configSchema = z.strictObject({
  version: z.literal(1).default(1),
  github: z.strictObject({ enabled: z.boolean().default(false), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional() }).default({ enabled: false }),
  /** Explicit gate commands override detection. Unset + undetected => gate is BLOCKED, never invented. */
  commands: z
    .strictObject({
      format: cmd, lint: cmd, typecheck: cmd, unit: cmd, build: cmd, integration: cmd, browser: cmd,
      'security-scan': cmd, migration: cmd, performance: cmd, load: cmd,
    })
    .default({}),
  allowedCommands: z.array(z.string()).default([]),
  app: z
    .strictObject({
      start: cmd,
      url: z.url().optional(),
      seed: cmd,
      startTimeoutMs: z.number().int().positive().default(60_000),
      /** Run the browser gate once per persona with PROOFLOOP_PERSONA set; the gate takes the worst outcome. */
      personas: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
      /** Directories (relative to the repo) holding traces/screenshots; hashed into the evidence ledger. */
      artifactDirs: z.array(z.string()).default([]),
      /** Playwright JSON report path (relative); tests titled "@AC-n" are mapped to acceptance criteria. */
      resultsFile: z.string().optional(),
    })
    .default({ startTimeoutMs: 60_000, personas: [], artifactDirs: [] }),
  limits: z
    .strictObject({
      maxParallel: z.number().int().min(1).max(8).default(1),
      gateTimeoutMs: z.number().int().positive().default(600_000),
      agentTimeoutMs: z.number().int().positive().default(1_800_000),
      maxBudgetUsd: z.number().positive().default(5),
      leaseTtlMs: z.number().int().positive().default(120_000),
      wallClockMs: z.number().int().positive().default(4 * 3_600_000),
    })
    .default({ maxParallel: 1, gateTimeoutMs: 600_000, agentTimeoutMs: 1_800_000, maxBudgetUsd: 5, leaseTtlMs: 120_000, wallClockMs: 4 * 3_600_000 }),
  retentionDays: z.number().int().positive().default(30),
  environment: z.enum(['local', 'dev', 'staging', 'production']).default('local'),
});
export type Config = z.infer<typeof configSchema>;

export const configPath = (root: string): string => join(root, '.proofloop', 'config.json');
export const stateDir = (root: string): string => join(root, '.proofloop');
export const dbPath = (root: string): string => join(stateDir(root), 'state.db');

export function loadConfig(root: string): Config {
  const p = configPath(root);
  if (!existsSync(p)) return configSchema.parse({});
  const parsed = configSchema.safeParse(JSON.parse(readFileSync(p, 'utf8')));
  if (!parsed.success) throw new PlError('PL_CONFIG_001', `invalid ${p}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

export function writeConfig(root: string, cfg: Config): void {
  mkdirSync(stateDir(root), { recursive: true });
  writeFileSync(configPath(root), `${JSON.stringify(cfg, null, 2)}\n`);
}
