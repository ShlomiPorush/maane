import type { Db } from "@maane/server/db/client"
import { makeSourceCurrent } from "@maane/server/intake/source"
import type { Settings } from "@maane/server/settings/service"

export async function reconcileIntakeSource(db: Db, settings: Settings): Promise<{ id: string } | null> {
  const tenantId = await settings.get("graph.tenantId")
  const mailbox = await settings.get("graph.mailbox")
  const current = await db.transaction((tx) => makeSourceCurrent(tx, tenantId, mailbox))
  return current ? { id: current.id } : null
}

export interface LockPool {
  connect(): Promise<{
    query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>
    release(): void
  }>
}

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
