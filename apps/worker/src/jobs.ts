import { writeFile } from "node:fs/promises"
import type { Db } from "@maane/server/db/client"
import {
  DELIVERY_POLL,
  FILES_SWEEP,
  GRAPH_TEST,
  INTAKE_FILES_RETRY,
  INTAKE_PROCESS,
  INTAKE_SYNC,
  PUSH_NOTIFY,
  QUEUE_OPTIONS,
  SCANNER_SELF_TEST,
  SEND_REPLY,
  SMTP_TEST,
  SNOOZE_END,
  TIMED_ACTION,
  TIMED_RECOVER,
  UPLOAD_SCAN,
  ZENDESK_IMPORT,
} from "@maane/server/jobs/queue"
import { errorFacts, log } from "@maane/server/log"
import type { Settings } from "@maane/server/settings/service"
import { snoozeEnded } from "@maane/server/tickets/snooze"
import { type GraphTestResult, PROVIDERS, type Provider } from "@maane/shared"
import type { PgBoss } from "pg-boss"
import { requeueOverdue, TimedActions, timedActionJob } from "./actions/run.ts"
import type { ActivityPoll } from "./delivery/poll.ts"
import { selfTestView } from "./files/self-test.ts"
import type { FileService } from "./files/service.ts"
import { importJob, type ZendeskImport } from "./import/run.ts"
import { type GraphGateway, graphConfig } from "./intake/graph.ts"
import { type LockPool, runExclusive } from "./intake/jobs.ts"
import type { IntakeProcessor } from "./intake/process.ts"
import type { WaitingFiles } from "./intake/retry.ts"
import type { IntakeSync } from "./intake/sync.ts"
import { type PushNotifier, pushNotifyJob } from "./notify/push.ts"
import { type ReplySender, sendReplyJob } from "./send/sender.ts"
import type { SmtpTimeouts } from "./send/smtp.ts"
import { smtpTest } from "./send/test.ts"
import { scanUpload } from "./send/uploads.ts"

export const HEARTBEAT_FILE = process.env.MAANE_HEARTBEAT_FILE || "/tmp/maane-worker-heartbeat"

export const HEARTBEAT_MAX_AGE_MS = 3 * 60_000

export interface JobOptions {
  heartbeatFile?: string
  now?: () => number
  files?: FileService
  intake?: IntakeJobs
  send?: SendJobs
  push?: PushNotifier
  zendeskImport?: { pool: LockPool; importer: ZendeskImport }
}

export interface SendJobs {
  db: Db
  settings: Settings
  sender: ReplySender
  poll?: ActivityPoll
  timeouts?: SmtpTimeouts
}

export interface IntakeJobs {
  pool: LockPool
  settings: Settings
  graph: GraphGateway
  sync: IntakeSync
  process: IntakeProcessor
  retry: WaitingFiles
}

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
    const actions = new TimedActions({
      db: send.db,
      settings: send.settings,
      queue: (db, name, data) => boss.send(name, data, { db }),
    })
    await boss.createQueue(TIMED_ACTION, QUEUE_OPTIONS[TIMED_ACTION])
    await boss.createQueue(SNOOZE_END, QUEUE_OPTIONS[SNOOZE_END])
    await boss.work<{ actionId?: unknown; version?: unknown }>(TIMED_ACTION, async ([job]) => {
      const { actionId, version } = job?.data ?? {}
      if (typeof actionId === "string" && Number.isSafeInteger(version))
        return { result: await timedActionJob(actions, actionId, version as number) }
    })
    await boss.work<{ ticketId?: unknown }>(SNOOZE_END, async ([job]) => {
      const ticketId = job?.data.ticketId
      if (typeof ticketId === "string") return { ended: await snoozeEnded(send.db, ticketId) }
    })
    await boss.createQueue(TIMED_RECOVER, { policy: "exclusive", expireInSeconds: 5 * 60 })
    await boss.schedule(TIMED_RECOVER, "*/5 * * * *")
    await boss.work(TIMED_RECOVER, async () => requeueOverdue(send.db, (name, data) => boss.send(name, data)))
    const poll = send.poll
    if (poll) {
      await boss.createQueue(DELIVERY_POLL, { policy: "exclusive", expireInSeconds: 30 * 60 })
      await boss.schedule(DELIVERY_POLL, "*/10 * * * *")
      await boss.work(DELIVERY_POLL, async () => poll.run())
    }
  }

  const zendesk = options.zendeskImport
  if (zendesk) {
    await boss.createQueue(ZENDESK_IMPORT, QUEUE_OPTIONS[ZENDESK_IMPORT])
    await boss.work<{ runId?: unknown }>(ZENDESK_IMPORT, async ([job]) => {
      const runId = job?.data.runId
      if (typeof runId !== "string") return
      const result = await runExclusive(zendesk.pool, ZENDESK_IMPORT, () => importJob(zendesk.importer, runId))
      if ("skipped" in result && result.skipped === "running")
        throw new Error("another import job holds the run lock; this one is tried again later")
      return result
    })
  }

  const push = options.push
  if (push) {
    await boss.createQueue(PUSH_NOTIFY, QUEUE_OPTIONS[PUSH_NOTIFY])
    await boss.work(PUSH_NOTIFY, async ([job]) => pushNotifyJob(push, job?.data))
  }

  const intake = options.intake
  if (!intake) return
  await boss.createQueue(GRAPH_TEST)
  await boss.work(GRAPH_TEST, async () => graphTest(intake.settings, intake.graph))
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
      await boss.send(INTAKE_PROCESS, {}).catch((error) => log.warn("could not queue processing", errorFacts(error)))
    }
  })
  await boss.work(INTAKE_PROCESS, async () => runExclusive(intake.pool, INTAKE_PROCESS, () => intake.process.run()))
  await boss.work(INTAKE_FILES_RETRY, async () =>
    runExclusive(intake.pool, INTAKE_FILES_RETRY, () => intake.retry.run()),
  )
  await boss.send(INTAKE_PROCESS, {})
}
