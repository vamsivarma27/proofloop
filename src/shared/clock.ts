import { randomUUID } from 'node:crypto';

export interface Clock {
  nowIso(): string;
  nowMs(): number;
}

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

export class FakeClock implements Clock {
  constructor(private ms = Date.parse('2026-01-01T00:00:00.000Z')) {}
  nowIso = (): string => new Date(this.ms).toISOString();
  nowMs = (): number => this.ms;
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
