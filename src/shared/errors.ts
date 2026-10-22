export class PlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = 'PlError';
  }
}

export const isPlError = (e: unknown, code?: string): e is PlError =>
  e instanceof PlError && (code === undefined || e.code === code);
