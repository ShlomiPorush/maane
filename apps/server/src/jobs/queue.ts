import { drizzle } from "drizzle-orm/node-postgres"
import pg from "pg"
import { PgBoss, type Queue, type Db as QueueDb } from "pg-boss"
import type { Db } from "../db/client.ts"
import * as schema from "../db/schema.ts"
import { errorFacts, log } from "../log.ts"

export const SCANNER_SELF_TEST = "scanner-self-test"
export const FILES_SWEEP = "files-sweep"
export const GRAPH_TEST = "graph-test"
export const INTAKE_SYNC = "intake-sync"
export const INTAKE_PROCESS = "intake-process"
export const INTAKE_FILES_RETRY = "intake-files-retry"

export const SEND_REPLY = "send-reply"
export const UPLOAD_SCAN = "upload-scan"
export const SMTP_TEST = "smtp-test"
export const DELIVERY_POLL = "delivery-poll"
export const TIMED_ACTION = "timed-action"
export const SNOOZE_END = "snooze-end"
export const TIMED_RECOVER = "timed-recover"

export const PUSH_NOTIFY = "push-notify"

export type PushKind = "new_ticket" | "customer_reply"
export type PushJob = { kind: PushKind; ticketId: string; messageId: string }

export const ZENDESK_IMPORT = "zendesk-import"

export const ZENDESK_IMPORT_HEARTBEAT_SECONDS = 120

export const QUEUE_OPTIONS: Record<string, Omit<Queue, "name">> = {
  [SEND_REPLY]: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 45 * 60 },
  [UPLOAD_SCAN]: { retryLimit: 3, retryDelay: 15, retryBackoff: true, expireInSeconds: 15 * 60 },
  [PUSH_NOTIFY]: { retryLimit: 0, expireInSeconds: 15 * 60 },
  [TIMED_ACTION]: { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 5 * 60 },
  [SNOOZE_END]: { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 5 * 60 },
  [ZENDESK_IMPORT]: { retryLimit: 5, retryDelay: 60, retryBackoff: true, expireInSeconds: 6 * 60 * 60 },
}

export type JobState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed"

export interface JobQueue {
  send(name: string, data?: object): Promise<string>
  sendIn(
    db: QueueDb,
    name: string,
    data: object,
    options?: { startAfter?: Date; heartbeatSeconds?: number },
  ): Promise<string>
  job(name: string, id: string): Promise<{ state: JobState; output: unknown } | null>
  pending(name: string, data: object): Promise<"active" | "created" | "retry" | null>
  stop(): Promise<void>
}

export async function openJobQueue(connectionString: string): Promise<JobQueue> {
  const boss = new PgBoss({ connectionString, schema: "pgboss", supervise: false, schedule: false })
  boss.on("error", (error) => log.error("the job queue reported an error", errorFacts(error)))
  await boss.start()
  await boss.createQueue(SCANNER_SELF_TEST)
  await boss.createQueue(GRAPH_TEST)
  await boss.createQueue(SMTP_TEST)
  await boss.createQueue(SEND_REPLY, QUEUE_OPTIONS[SEND_REPLY])
  await boss.createQueue(UPLOAD_SCAN, QUEUE_OPTIONS[UPLOAD_SCAN])
  await boss.createQueue(TIMED_ACTION, QUEUE_OPTIONS[TIMED_ACTION])
  await boss.createQueue(SNOOZE_END, QUEUE_OPTIONS[SNOOZE_END])
  await boss.createQueue(ZENDESK_IMPORT, QUEUE_OPTIONS[ZENDESK_IMPORT])
  return {
    async send(name, data = {}) {
      const id = await boss.send(name, data)
      if (!id) throw new Error(`the queue did not accept a ${name} job`)
      return id
    },
    async sendIn(db, name, data, options = {}) {
      const id = await boss.send(name, data, {
        db,
        ...(options.startAfter ? { startAfter: options.startAfter } : {}),
        ...(options.heartbeatSeconds ? { heartbeatSeconds: options.heartbeatSeconds } : {}),
      })
      if (!id) throw new Error(`the queue did not accept a ${name} job`)
      return id
    },
    async job(name, id) {
      const job = await boss.getJobById(name, id)
      return job ? { state: job.state as JobState, output: job.output ?? null } : null
    },
    async pending(name, data) {
      const states = new Set((await boss.findJobs(name, { data })).map((job) => job.state))
      return (["active", "created", "retry"] as const).find((state) => states.has(state)) ?? null
    },
    stop: () => boss.stop({ graceful: false }),
  }
}

export async function transactionWithJobs<T>(db: Db, work: (tx: Db, jobs: QueueDb) => Promise<T>): Promise<T> {
  const pool = (db as Db & { $client?: pg.Pool }).$client
  if (!(pool instanceof pg.Pool))
    throw new Error("transactionWithJobs needs the database of openDatabase, not a transaction")
  const client = await pool.connect()
  try {
    const own = drizzle(client, { schema })
    const jobs: QueueDb = { executeSql: (text, values) => client.query(text, values) }
    return await own.transaction((tx) => work(tx as unknown as Db, jobs))
  } finally {
    client.release()
  }
}
