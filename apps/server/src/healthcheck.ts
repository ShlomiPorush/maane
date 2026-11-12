// The container health check: the server answers /healthz/ready (the database answers and is migrated).
export {}

const port = Number(process.env.PORT ?? 8080)
try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz/ready`, { signal: AbortSignal.timeout(4000) })
  process.exit(response.ok ? 0 : 1)
} catch {
  process.exit(1)
}
