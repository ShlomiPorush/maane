// The import window (plan 5.1, phase 6): imports happen until an admin presses Finish import, which records
// `zendesk_import.finished_at` and closes the window for good; it is refused while a run is open. Until then an
// imported ticket is read-only for agents: every action on it, and the deletion of a category one carries, is refused
// here. Live intake may still attach mail to an imported ticket meanwhile (Maane is live from the first moment).
//
// Lock order: the import's row, then the run's row. Finish, a start, and the mappings lock the import's row FOR UPDATE
// before they read the window and the open run; every ticket of a run locks it FOR SHARE first, so they serialize.

import { and, eq, isNotNull, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { importRun, ticket, ticketCategory, zendeskImport } from "../db/schema.ts"
import { Refusal } from "../organizations/refusal.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export interface ImportWindow {
  open: boolean
  finishedAt: Date | null
}

/** When an admin pressed Finish import, or null. */
export async function finishedAt(tx: Pick<Tx, "select">): Promise<Date | null> {
  const [row] = await tx.select({ at: zendeskImport.finishedAt }).from(zendeskImport).where(eq(zendeskImport.id, 1))
  return row?.at ?? null
}

/**
 * The window as this transaction sees it. With `lock`, the import's row is held (`update` for a change of the window
 * or a start, `share` for a run's ticket) until the transaction ends.
 */
export async function importWindow(tx: Pick<Tx, "select">, lock?: "update" | "share"): Promise<ImportWindow> {
  const query = tx.select({ at: zendeskImport.finishedAt }).from(zendeskImport).where(eq(zendeskImport.id, 1))
  const [row] = lock ? await query.for(lock) : await query
  const at = row?.at ?? null
  return { open: at === null, finishedAt: at }
}

/**
 * Finish import (an admin's action, final): under the import's row, refused while a run is open; records when. Returns
 * false when the import was already finished.
 */
export async function finishImport(tx: Pick<Tx, "select" | "update">): Promise<boolean> {
  const window = await importWindow(tx, "update")
  if (!window.open) return false
  const [open] = await tx.select({ id: importRun.id }).from(importRun).where(eq(importRun.state, "running")).limit(1)
  if (open) throw new Refusal("import_running", 409)
  await tx.update(zendeskImport).set({ finishedAt: sql`now()`, updatedAt: new Date() }).where(eq(zendeskImport.id, 1))
  return true
}

/** Whether a ticket is imported and still read-only for agents (the import is not finished). */
export async function importedReadOnly(tx: Pick<Tx, "select">, ticketId: string): Promise<boolean> {
  const [row] = await tx.select({ zendeskId: ticket.zendeskId }).from(ticket).where(eq(ticket.id, ticketId))
  if (row?.zendeskId === null || row?.zendeskId === undefined) return false
  return (await finishedAt(tx)) === null
}

/** Refuses an agent's change to an imported ticket until the import is finished. */
export async function refuseImported(tx: Pick<Tx, "select">, ticketId: string): Promise<void> {
  if (await importedReadOnly(tx, ticketId)) throw new Refusal("ticket_imported", 409)
}

/** Refuses deleting a category an imported ticket carries until the import is finished (it would change that ticket). */
export async function refuseImportedCategory(tx: Pick<Tx, "select">, categoryId: string): Promise<void> {
  if ((await finishedAt(tx)) !== null) return
  const [carried] = await tx
    .select({ one: sql<number>`1` })
    .from(ticketCategory)
    .innerJoin(ticket, eq(ticket.id, ticketCategory.ticketId))
    .where(and(eq(ticketCategory.categoryId, categoryId), isNotNull(ticket.zendeskId)))
    .limit(1)
  if (carried) throw new Refusal("category_imported", 409)
}
