/**
 * A request the service refuses on purpose: a stable code the API returns as {error: code, ...details} and the UI
 * explains in words (apps/web/src/api/errors.ts). Anything else that fails is an internal error.
 */
export class Refusal extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code)
    this.name = "Refusal"
  }
}

/**
 * The PostgreSQL error code of a failed query (`23505` unique, `23503` foreign key), and the constraint it names.
 * Drizzle wraps the driver's error, so the code may sit on the error or on its cause.
 */
export function databaseError(error: unknown): { code: string; constraint: string | null } | null {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code))
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === "string" ? candidate.constraint : null,
      }
    current = candidate.cause
  }
  return null
}
