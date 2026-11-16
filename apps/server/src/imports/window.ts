// The import window (plan 5.1, "the rule that keeps it simple"): imports happen only while intake listens and Maane
// has never gone live. The first switch of the intake mode to live records that fact in the import's row and closes
// the window for good; a switch to live is refused while a run is open. Until then an imported ticket is read-only:
// every action on it, and the deletion of a category one carries, is refused here.
//
// Lock order: the intake mode row, then the import's row. A switch to live locks the mode row FOR UPDATE before it
// reads the runs; a start and every ticket of a run lock it FOR SHARE first, so they serialize with a switch.

import { type IntakeMode, SETTINGS } from "@maane/shared"
import { and, eq, isNotNull, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { importRun, setting, ticket, ticketCategory, zendeskImport } from "../db/schema.ts"
import { Refusal } from "../organizations/refusal.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export interface ImportWindow {
  open: boolean
  mode: IntakeMode
  wentLiveAt: Date | null
}

const modeOf = (value: unknown): IntakeMode => {
  const parsed = SETTINGS["intake.mode"].schema.safeParse(value)
  return parsed.success ? parsed.data : SETTINGS["intake.mode"].defaultValue
}

/** When Maane first went live, or null. */
export async function wentLiveAt(tx: Pick<Tx, "select">): Promise<Date | null> {
  const [row] = await tx.select({ at: zendeskImport.wentLiveAt }).from(zendeskImport).where(eq(zendeskImport.id, 1))
  return row?.at ?? null
}

/**
 * The window as this transaction sees it. With `lock`, the mode row is held FOR SHARE until the transaction ends, so
 * a switch to live waits for it (a start, and each ticket of a run).
 */
export async function importWindow(tx: Pick<Tx, "select">, lock = false): Promise<ImportWindow> {
  const query = tx.select({ value: setting.value }).from(setting).where(eq(setting.key, "intake.mode"))
  const [row] = lock ? await query.for("share") : await query
  const mode = modeOf(row?.value)
  const at = await wentLiveAt(tx)
  return { open: mode === "listening" && at === null, mode, wentLiveAt: at }
}

/**
 * A switch of the intake mode to live (called by the settings service inside its transaction, before it writes):
 * locks the mode row FOR UPDATE, refuses while an import run is open, and records the first time Maane went live.
 */
export async function goingLive(tx: Pick<Tx, "select" | "update">): Promise<void> {
  await tx.select({ key: setting.key }).from(setting).where(eq(setting.key, "intake.mode")).for("update")
  const [open] = await tx.select({ id: importRun.id }).from(importRun).where(eq(importRun.state, "running")).limit(1)
  if (open) throw new Refusal("import_running", 409, { key: "intake.mode" })
  await tx
    .update(zendeskImport)
    .set({ wentLiveAt: sql`coalesce(${zendeskImport.wentLiveAt}, now())`, updatedAt: new Date() })
    .where(eq(zendeskImport.id, 1))
}

/** Whether a ticket is imported and still read-only (Maane never went live). */
export async function importedReadOnly(tx: Pick<Tx, "select">, ticketId: string): Promise<boolean> {
  const [row] = await tx.select({ zendeskId: ticket.zendeskId }).from(ticket).where(eq(ticket.id, ticketId))
  if (row?.zendeskId === null || row?.zendeskId === undefined) return false
  return (await wentLiveAt(tx)) === null
}

/** Refuses any change to an imported ticket until Maane goes live. */
export async function refuseImported(tx: Pick<Tx, "select">, ticketId: string): Promise<void> {
  if (await importedReadOnly(tx, ticketId)) throw new Refusal("ticket_imported", 409)
}

/** Refuses deleting a category an imported ticket carries until Maane goes live (it would change that ticket). */
export async function refuseImportedCategory(tx: Pick<Tx, "select">, categoryId: string): Promise<void> {
  if ((await wentLiveAt(tx)) !== null) return
  const [carried] = await tx
    .select({ one: sql<number>`1` })
    .from(ticketCategory)
    .innerJoin(ticket, eq(ticket.id, ticketCategory.ticketId))
    .where(and(eq(ticketCategory.categoryId, categoryId), isNotNull(ticket.zendeskId)))
    .limit(1)
  if (carried) throw new Refusal("category_imported", 409)
}
