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

export function errorFacts(error: unknown): Fields {
  if (!(error instanceof Error)) return { errorClass: typeof error }
  const e = error as Error & { code?: unknown; status?: unknown }
  return {
    errorClass: e.name,
    ...(typeof e.code === "string" ? { code: e.code } : {}),
    ...(typeof e.status === "number" || typeof e.status === "string" ? { status: String(e.status) } : {}),
  }
}

export function loggedPath(pathname: string): string {
  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
  } catch {}
  const hidden = (path: string) => /^\/+hooks(?:\/|$)/i.test(path)
  return hidden(pathname) || hidden(decoded) ? "/hooks/[hidden]" : pathname
}
