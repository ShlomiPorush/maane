import { writeFile } from "node:fs/promises"
import type { PgBoss } from "pg-boss"

/** The file the worker's health check reads: the time of the last heartbeat job, in milliseconds. */
export const HEARTBEAT_FILE = process.env.MAANE_HEARTBEAT_FILE || "/tmp/maane-worker-heartbeat"

/** A heartbeat older than this means the queue stopped running jobs. */
export const HEARTBEAT_MAX_AGE_MS = 3 * 60_000

export interface JobOptions {
  heartbeatFile?: string
  now?: () => number
}

/**
 * The jobs this worker runs. In 1b only the heartbeat: a scheduled job that proves the queue picks up and finishes
 * work. Later phases add intake, sending, delivery polling, scheduled actions, and notifications here.
 */
export async function registerJobs(boss: PgBoss, options: JobOptions = {}): Promise<void> {
  const heartbeatFile = options.heartbeatFile ?? HEARTBEAT_FILE
  const now = options.now ?? Date.now
  await boss.createQueue("heartbeat")
  await boss.schedule("heartbeat", "* * * * *")
  await boss.work("heartbeat", async () => {
    await writeFile(heartbeatFile, String(now()))
  })
}
