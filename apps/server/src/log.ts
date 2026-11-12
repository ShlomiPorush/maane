// One JSON line per event on stdout (errors on stderr). Never a secret, token, cookie, password, or message
// content: callers pass facts, and errorFacts keeps only the class, the code, and the PostgreSQL SQLSTATE of an
// error, never its message, which can hold a failed query with its parameters.

type Fields = Record<string, string | number | boolean | null | undefined>

function write(level: "info" | "warn" | "error", message: string, fields: Fields = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })
  if (level === "error") process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

export const log = {
  info: (message: string, fields?: Fields) => write("info", message, fields),
  warn: (message: string, fields?: Fields) => write("warn", message, fields),
  error: (message: string, fields?: Fields) => write("error", message, fields),
}

/** What may be logged about an error: its class, its code, and a PostgreSQL SQLSTATE. Never its message. */
export function errorFacts(error: unknown): Fields {
  if (!(error instanceof Error)) return { errorClass: typeof error }
  const e = error as Error & { code?: unknown; status?: unknown }
  return {
    errorClass: e.name,
    ...(typeof e.code === "string" ? { code: e.code } : {}),
    ...(typeof e.status === "number" || typeof e.status === "string" ? { status: String(e.status) } : {}),
  }
}
