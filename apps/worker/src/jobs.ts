import { writeFile } from "node:fs/promises"
import { FILES_SWEEP, SCANNER_SELF_TEST } from "@maane/server/jobs/queue"
import type { PgBoss } from "pg-boss"
import { selfTestView } from "./files/self-test.ts"
import type { FileService } from "./files/service.ts"

/** The file the worker's health check reads: the time of the last heartbeat job, in milliseconds. */
export const HEARTBEAT_FILE = process.env.MAANE_HEARTBEAT_FILE || "/tmp/maane-worker-heartbeat"

/** A heartbeat older than this means the queue stopped running jobs. */
export const HEARTBEAT_MAX_AGE_MS = 3 * 60_000

export interface JobOptions {
  heartbeatFile?: string
  now?: () => number
  /** The file service; without it (tests of the heartbeat alone) the file jobs are not registered. */
  files?: FileService
}

/**
 * The jobs this worker runs: the heartbeat, a scheduled job that proves the queue picks up and finishes work; the
 * scanner self-test (queued once at start, every hour, when the address changes, and for a connection test; its output
 * is the result the Settings page polls for); and the daily sweep of unreferenced stored files. Later phases add
 * intake, sending, delivery polling, scheduled actions, and notifications here.
 */
export async function registerJobs(boss: PgBoss, options: JobOptions = {}): Promise<void> {
  const heartbeatFile = options.heartbeatFile ?? HEARTBEAT_FILE
  const now = options.now ?? Date.now
  await boss.createQueue("heartbeat")
  await boss.schedule("heartbeat", "* * * * *")
  await boss.work("heartbeat", async () => {
    await writeFile(heartbeatFile, String(now()))
  })

  const files = options.files
  if (!files) return
  await boss.createQueue(SCANNER_SELF_TEST)
  await boss.schedule(SCANNER_SELF_TEST, "7 * * * *")
  await boss.work(SCANNER_SELF_TEST, async () => selfTestView(await files.selfTest()))
  await boss.createQueue(FILES_SWEEP)
  await boss.schedule(FILES_SWEEP, "37 3 * * *")
  await boss.work(FILES_SWEEP, async () => files.sweep())
  // The self-test on start: scans trust no scanner until it passed.
  await boss.send(SCANNER_SELF_TEST, {})
}
