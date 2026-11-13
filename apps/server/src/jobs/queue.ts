import { drizzle } from "drizzle-orm/node-postgres"
import pg from "pg"
import { PgBoss, type Db as QueueDb, type QueueOptions } from "pg-boss"
import type { Db } from "../db/client.ts"
import * as schema from "../db/schema.ts"
import { errorFacts, log } from "../log.ts"

// The job queues the server and the worker share. The worker runs every job; the server only queues the ones a user
// asks for (a scanner, Graph, or SMTP connection test, a reply to send, an upload to scan) and reads their state,
// through pg-boss's documented send and getJobById. The server never calls an outside service itself.

/** The scanner self-test: on worker start, every hour, when the scanner address changes, and for a connection test. */
export const SCANNER_SELF_TEST = "scanner-self-test"
/** The daily sweep of stored files no row references (a crash between the rename and the commit leaves one). */
export const FILES_SWEEP = "files-sweep"
/** The Graph connection test: reads the intake mailbox's Inbox folder metadata, nothing else (plan 2.3, P12). */
export const GRAPH_TEST = "graph-test"
/** Stage one of intake: delta queries of the current source's folders, storing new messages (every minute). */
export const INTAKE_SYNC = "intake-sync"
/** Stage two: processes stored messages, oldest first (after each sync, every minute, and at worker start). */
export const INTAKE_PROCESS = "intake-process"
/** Fetches again the messages whose files wait for the scanner, and scans those files again. */
export const INTAKE_FILES_RETRY = "intake-files-retry"

/** Sends a reply (plan 3.1): `{ messageId }`. The outbox row's state, not the queue, keeps a reply from going twice. */
export const SEND_REPLY = "send-reply"
/** Scans an upload of the composer and stores what may be kept: `{ uploadId }`. */
export const UPLOAD_SCAN = "upload-scan"
/** An SMTP connection test of one provider: `{ provider }`. */
export const SMTP_TEST = "smtp-test"
/** SMTP2GO's activity search for recipients without a final delivery status (plan 3.3), every ten minutes. */
export const DELIVERY_POLL = "delivery-poll"

/**
 * The options of the queues the server sends to in a transaction, the same on both sides: pg-boss keeps the options of
 * the first createQueue. A failed run is tried again; a reply's outbox state makes a retry safe (it never sends what
 * an earlier run may have sent).
 */
export const QUEUE_OPTIONS: Record<string, QueueOptions> = {
  // Longer than the slowest run (two providers, each up to SMTP_TIMEOUTS' setup and send deadlines, about 23 minutes),
  // so pg-boss never retries a run that still sends.
  [SEND_REPLY]: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 45 * 60 },
  [UPLOAD_SCAN]: { retryLimit: 3, retryDelay: 15, retryBackoff: true, expireInSeconds: 15 * 60 },
}

/** pg-boss's states of a job, as the server reports them to the UI. */
export type JobState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed"

export interface JobQueue {
  /** Queues a job and returns its id. */
  send(name: string, data?: object): Promise<string>
  /**
   * Queues a job inside the caller's transaction (pg-boss's documented `db` option): the job exists exactly when the
   * transaction commits. Throws when the queue takes nothing, so the transaction rolls back.
   */
  sendIn(db: QueueDb, name: string, data: object): Promise<string>
  /** A job's state and the output its handler returned, or null when no such job exists. */
  job(name: string, id: string): Promise<{ state: JobState; output: unknown } | null>
  stop(): Promise<void>
}

/**
 * The server's handle on the queue: pg-boss without its supervision and scheduling, which belong to the worker. It
 * creates the queues it sends to, so a test queued before the worker's first start is not refused.
 */
export async function openJobQueue(connectionString: string): Promise<JobQueue> {
  const boss = new PgBoss({ connectionString, schema: "pgboss", supervise: false, schedule: false })
  boss.on("error", (error) => log.error("the job queue reported an error", errorFacts(error)))
  await boss.start()
  await boss.createQueue(SCANNER_SELF_TEST)
  await boss.createQueue(GRAPH_TEST)
  await boss.createQueue(SMTP_TEST)
  await boss.createQueue(SEND_REPLY, QUEUE_OPTIONS[SEND_REPLY])
  await boss.createQueue(UPLOAD_SCAN, QUEUE_OPTIONS[UPLOAD_SCAN])
  return {
    async send(name, data = {}) {
      const id = await boss.send(name, data)
      if (!id) throw new Error(`the queue did not accept a ${name} job`)
      return id
    },
    async sendIn(db, name, data) {
      const id = await boss.send(name, data, { db })
      if (!id) throw new Error(`the queue did not accept a ${name} job`)
      return id
    },
    async job(name, id) {
      const job = await boss.getJobById(name, id)
      return job ? { state: job.state as JobState, output: job.output ?? null } : null
    },
    stop: () => boss.stop({ graceful: false }),
  }
}

/**
 * A transaction on a connection of its own, with the handle pg-boss's `db` option takes for that same connection, so
 * rows and the jobs that act on them commit together (plan 3.1). Drizzle documents `$client` (the pool) and a client
 * as a driver; pg-boss documents `executeSql`.
 */
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
