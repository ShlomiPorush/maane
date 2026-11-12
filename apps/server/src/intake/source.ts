// The intake source (plan 2.3, P13, P18): each pair of Entra tenant and intake mailbox is one row of intake_source,
// and at most one row is current. Cursors, stored messages, and jobs carry the source's ID. A settings change of the
// tenant or the mailbox, and the worker at start (when variables set them), make the matching row current here, after
// locking the current row FOR UPDATE, so a store that holds it FOR SHARE finishes first and one that starts later sees
// the new current row and rolls back.

import { and, eq, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { intakeSource } from "../db/schema.ts"

/** A transaction of Maane's connection. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export type IntakeSource = typeof intakeSource.$inferSelect

/** The tenant and the mailbox as a source keeps them: trimmed, in lower case. */
export const sourceKey = (tenantId: string, mailbox: string) => ({
  tenantId: tenantId.trim().toLowerCase(),
  mailbox: mailbox.trim().toLowerCase(),
})

/** The current source, locked FOR UPDATE until the transaction ends (a change), or null when none is current. */
export async function lockCurrentSourceForChange(tx: Tx): Promise<IntakeSource | null> {
  const [row] = await tx.select().from(intakeSource).where(eq(intakeSource.current, true)).for("update")
  return row ?? null
}

/**
 * Makes the source of this tenant and mailbox current, creating it when new; with either one empty, no source is
 * current. Locks the current row FOR UPDATE first. Returns the current source, or null.
 */
export async function makeSourceCurrent(tx: Tx, tenantId: string, mailbox: string): Promise<IntakeSource | null> {
  const key = sourceKey(tenantId, mailbox)
  const current = await lockCurrentSourceForChange(tx)
  const complete = key.tenantId !== "" && key.mailbox !== ""
  if (current && complete && current.tenantId === key.tenantId && current.mailbox === key.mailbox) return current
  if (current) await tx.update(intakeSource).set({ current: false }).where(eq(intakeSource.id, current.id))
  if (!complete) return null
  await tx
    .insert(intakeSource)
    .values({ ...key })
    .onConflictDoNothing({ target: [intakeSource.tenantId, intakeSource.mailbox] })
  const [made] = await tx
    .update(intakeSource)
    .set({ current: true })
    .where(and(eq(intakeSource.tenantId, key.tenantId), eq(intakeSource.mailbox, key.mailbox)))
    .returning()
  return made ?? null
}

/**
 * Locks a source FOR SHARE until the transaction ends and says whether it is still current. Every transaction that
 * stores newly fetched messages or a cursor calls it first and rolls back when it is not.
 */
export async function holdSourceIfCurrent(tx: Pick<Tx, "execute">, sourceId: string): Promise<boolean> {
  const result = await tx.execute(sql`select current from intake_source where id = ${sourceId} for share`)
  const row = result.rows[0] as { current?: boolean } | undefined
  return row?.current === true
}
