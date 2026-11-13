import { writeFile } from "node:fs/promises"
import type { Db } from "@maane/server/db/client"
import {
  DELIVERY_POLL,
  FILES_SWEEP,
  GRAPH_TEST,
  INTAKE_FILES_RETRY,
  INTAKE_PROCESS,
  INTAKE_SYNC,
  QUEUE_OPTIONS,
  SCANNER_SELF_TEST,
  SEND_REPLY,
  SMTP_TEST,
  UPLOAD_SCAN,
} from "@maane/server/jobs/queue"
import { errorFacts, log } from "@maane/server/log"
import type { Settings } from "@maane/server/settings/service"
import { type GraphTestResult, PROVIDERS, type Provider } from "@maane/shared"
import type { PgBoss } from "pg-boss"
import type { ActivityPoll } from "./delivery/poll.ts"
import { selfTestView } from "./files/self-test.ts"
import type { FileService } from "./files/service.ts"
import { type GraphGateway, graphConfig } from "./intake/graph.ts"
import { type LockPool, runExclusive } from "./intake/jobs.ts"
import type { IntakeProcessor } from "./intake/process.ts"
import type { WaitingFiles } from "./intake/retry.ts"
import type { IntakeSync } from "./intake/sync.ts"
import { type ReplySender, sendReplyJob } from "./send/sender.ts"
import type { SmtpTimeouts } from "./send/smtp.ts"
import { smtpTest } from "./send/test.ts"
import { scanUpload } from "./send/uploads.ts"

/** The file the worker's health check reads: the time of the last heartbeat job, in milliseconds. */
export const HEARTBEAT_FILE = process.env.MAANE_HEARTBEAT_FILE || "/tmp/maane-worker-heartbeat"

/** A heartbeat older than this means the queue stopped running jobs. */
export const HEARTBEAT_MAX_AGE_MS = 3 * 60_000

export interface JobOptions {
  heartbeatFile?: string
  now?: () => number
  /** The file service; without it (tests of the heartbeat alone) the file jobs are not registered. */
  files?: FileService
  /** Graph intake; without it (tests of other jobs) the intake jobs are not registered. */
  intake?: IntakeJobs
  /** Replies (plan 3.1): sending, the composer's uploads, and the SMTP connection tests. Needs `files`. */
  send?: SendJobs
}

export interface SendJobs {
  db: Db
  settings: Settings
  sender: ReplySender
  /** SMTP2GO's activity search for delivery statuses (plan 3.3); without it the poll is not registered. */
  poll?: ActivityPoll
  /** The connection tests' timeouts (tests make them short). */
  timeouts?: SmtpTimeouts
}

export interface IntakeJobs {
  /** The pool the run locks take a connection of their own from. */
  pool: LockPool
  settings: Settings
  graph: GraphGateway
  sync: IntakeSync
  process: IntakeProcessor
  retry: WaitingFiles
}

/** The Graph connection test (P12): the saved settings, the Inbox folder's metadata, nothing else. */
export async function graphTest(settings: Settings, graph: GraphGateway): Promise<GraphTestResult> {
  const config = await graphConfig(settings)
  if (!config)
    return {
      ok: false,
      problem: "not_configured",
      code: null,
      status: null,
      mailbox: (await settings.get("graph.mailbox")).toLowerCase(),
      checkedAt: new Date().toISOString(),
    }
  return graph.test(config)
}

/**
 * The jobs this worker runs: the heartbeat, a scheduled job that proves the queue picks up and finishes work; the
 * scanner self-test (queued once at start, every hour, when the address changes, and for a connection test; its output
 * is the result the Settings page polls for); the daily sweep of unreferenced stored files; and Graph intake (plan
 * 2.3): the connection test, stage one every minute, stage two after each sync, every minute, and once at start, and the
 * retry of waiting files every five minutes; sending (plan 3.1) and the activity poll of delivery statuses every ten
 * minutes (plan 3.3). Later phases add scheduled actions and notifications here.
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

  const send = options.send
  if (send) {
    await boss.createQueue(SEND_REPLY, QUEUE_OPTIONS[SEND_REPLY])
    await boss.createQueue(UPLOAD_SCAN, QUEUE_OPTIONS[UPLOAD_SCAN])
    await boss.createQueue(SMTP_TEST)
    await boss.work<{ messageId?: unknown }>(SEND_REPLY, async ([job]) => {
      const id = job?.data.messageId
      if (typeof id === "string") return { state: await sendReplyJob(send.sender, id) }
    })
    await boss.work<{ uploadId?: unknown }>(UPLOAD_SCAN, async ([job]) => {
      const id = job?.data.uploadId
      if (typeof id === "string") return { status: await scanUpload(send.db, files, id) }
    })
    await boss.work<{ provider?: unknown }>(SMTP_TEST, async ([job]) => {
      const provider = job?.data.provider
      if ((PROVIDERS as readonly unknown[]).includes(provider))
        return smtpTest(send.settings, provider as Provider, send.timeouts)
    })
    const poll = send.poll
    if (poll) {
      // One run at a time; a failed run leaves the cursor where it was, and the next one reads its window again.
      await boss.createQueue(DELIVERY_POLL, { policy: "exclusive", expireInSeconds: 30 * 60 })
      await boss.schedule(DELIVERY_POLL, "*/10 * * * *")
      await boss.work(DELIVERY_POLL, async () => poll.run())
    }
  }

  const intake = options.intake
  if (!intake) return
  await boss.createQueue(GRAPH_TEST)
  await boss.work(GRAPH_TEST, async () => graphTest(intake.settings, intake.graph))
  // One sync and one processing run at a time: the queue holds one job queued or active, and a session lock guards
  // against a run pg-boss expired while its handler still works.
  await boss.createQueue(INTAKE_SYNC, {
    policy: "exclusive",
    expireInSeconds: 30 * 60,
    retryLimit: 3,
    retryDelay: 15,
    retryBackoff: true,
  })
  await boss.createQueue(INTAKE_PROCESS, { policy: "exclusive", expireInSeconds: 30 * 60 })
  await boss.createQueue(INTAKE_FILES_RETRY, { policy: "exclusive", expireInSeconds: 30 * 60 })
  await boss.schedule(INTAKE_SYNC, "* * * * *")
  await boss.schedule(INTAKE_PROCESS, "* * * * *")
  await boss.schedule(INTAKE_FILES_RETRY, "*/5 * * * *")
  await boss.work(INTAKE_SYNC, async () => {
    try {
      return await runExclusive(intake.pool, INTAKE_SYNC, () => intake.sync.run())
    } finally {
      // Stored messages are processed after each round, also when the round failed halfway.
      await boss.send(INTAKE_PROCESS, {}).catch((error) => log.warn("could not queue processing", errorFacts(error)))
    }
  })
  await boss.work(INTAKE_PROCESS, async () => runExclusive(intake.pool, INTAKE_PROCESS, () => intake.process.run()))
  await boss.work(INTAKE_FILES_RETRY, async () =>
    runExclusive(intake.pool, INTAKE_FILES_RETRY, () => intake.retry.run()),
  )
  // Processing at start (P19): what stage one stored is processed even while Graph cannot be reached.
  await boss.send(INTAKE_PROCESS, {})
}
