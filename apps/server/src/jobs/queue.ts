import { PgBoss } from "pg-boss"
import { errorFacts, log } from "../log.ts"

// The job queues the server and the worker share. The worker runs every job; the server only queues the ones a user
// asks for (a scanner or Graph connection test) and reads their state, through pg-boss's documented send and getJobById. The
// server never calls an outside service itself.

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

/** pg-boss's states of a job, as the server reports them to the UI. */
export type JobState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed"

export interface JobQueue {
  /** Queues a job and returns its id. */
  send(name: string, data?: object): Promise<string>
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
  return {
    async send(name, data = {}) {
      const id = await boss.send(name, data)
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
