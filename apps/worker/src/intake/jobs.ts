// The intake jobs' wiring: the source reconciliation the worker runs before any job, and a session advisory lock that
// keeps one run of a job at a time even when pg-boss expires a job whose handler still runs (its expiry does not stop
// the handler, plan 2.2).

import type { Db } from "@maane/server/db/client"
import { makeSourceCurrent } from "@maane/server/intake/source"
import type { Settings } from "@maane/server/settings/service"

/**
 * Before any job starts (P18): the tenant and the mailbox in effect, the environment's included (which change only
 * with a restart), make their source current under the same lock a settings change takes.
 */
export async function reconcileIntakeSource(db: Db, settings: Settings): Promise<{ id: string } | null> {
  const tenantId = await settings.get("graph.tenantId")
  const mailbox = await settings.get("graph.mailbox")
  const current = await db.transaction((tx) => makeSourceCurrent(tx, tenantId, mailbox))
  return current ? { id: current.id } : null
}

/** What the run lock needs of a pg pool: a connection of its own. */
export interface LockPool {
  connect(): Promise<{
    query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>
    release(): void
  }>
}

/**
 * Runs `work` while holding a session advisory lock named for the job on a connection of its own, or returns
 * `{ skipped: "running" }` at once when another run holds it.
 */
export async function runExclusive<T>(
  pool: LockPool,
  name: string,
  work: () => Promise<T>,
): Promise<T | { skipped: "running" }> {
  const client = await pool.connect()
  try {
    const result = await client.query("select pg_try_advisory_lock(hashtextextended($1, 0)) as locked", [`job:${name}`])
    if ((result.rows[0] as { locked?: boolean } | undefined)?.locked !== true) return { skipped: "running" }
    try {
      return await work()
    } finally {
      await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`job:${name}`])
    }
  } finally {
    client.release()
  }
}
