import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Clock, systemClock } from './clock';
import { redactValue } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, event: string, data?: Record<string, unknown>): void;
}

/** JSON-lines logger; every record is redacted before it is written. */
export class FileLogger implements Logger {
  constructor(
    private readonly path: string,
    private readonly clock: Clock = systemClock,
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    const record = redactValue({ ts: this.clock.nowIso(), level, event, ...data });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }
}

export class MemoryLogger implements Logger {
  readonly records: Array<{ level: LogLevel; event: string; data: Record<string, unknown> }> = [];
  log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    this.records.push({ level, event, data: redactValue(data) });
  }
}

export const nullLogger: Logger = { log: () => undefined };
