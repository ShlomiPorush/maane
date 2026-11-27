import { access, rm } from "node:fs/promises"

const DRAIN_FILE = "/tmp/drain"

export async function serverHealthy(port: number, drainFile = DRAIN_FILE): Promise<boolean> {
  const draining = await access(drainFile).then(
    () => true,
    () => false,
  )
  if (draining) return false
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz/ready`, { signal: AbortSignal.timeout(4000) })
    return response.ok
  } catch {
    return false
  }
}

export async function stopDraining(drainFile = DRAIN_FILE): Promise<void> {
  await rm(drainFile, { force: true })
}
