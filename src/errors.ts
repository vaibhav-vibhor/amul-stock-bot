export class SafeError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterSeconds = 0,
  ) {
    super(code);
    this.name = "SafeError";
  }
}

export function errorCode(error: unknown): string {
  return error instanceof SafeError ? error.code : "internal_error";
}

export function logFailure(operation: string, error: unknown): void {
  // Never log fetch exceptions, response bodies, cookies, update bodies or URLs.
  console.error(JSON.stringify({ operation, error: errorCode(error) }));
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function json(text: string, code: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SafeError(code);
  }
}
