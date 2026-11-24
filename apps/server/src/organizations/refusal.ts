export class Refusal extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code)
    this.name = "Refusal"
  }
}

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
