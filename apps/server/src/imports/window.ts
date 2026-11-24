import { and, eq, isNotNull, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { importRun, ticket, ticketCategory, zendeskImport } from "../db/schema.ts"
import { Refusal } from "../organizations/refusal.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export interface ImportWindow {
  open: boolean
  finishedAt: Date | null
}

export async function finishedAt(tx: Pick<Tx, "select">): Promise<Date | null> {
  const [row] = await tx.select({ at: zendeskImport.finishedAt }).from(zendeskImport).where(eq(zendeskImport.id, 1))
  return row?.at ?? null
}

export async function importWindow(tx: Pick<Tx, "select">, lock?: "update"): Promise<ImportWindow> {
  const query = tx.select({ at: zendeskImport.finishedAt }).from(zendeskImport).where(eq(zendeskImport.id, 1))
  const [row] = lock ? await query.for(lock) : await query
  const at = row?.at ?? null
  return { open: at === null, finishedAt: at }
}

export async function finishImport(tx: Pick<Tx, "select" | "update">): Promise<boolean> {
  const window = await importWindow(tx, "update")
  if (!window.open) return false
  const [open] = await tx.select({ id: importRun.id }).from(importRun).where(eq(importRun.state, "running")).limit(1)
  if (open) throw new Refusal("import_running", 409)
  await tx.update(zendeskImport).set({ finishedAt: sql`now()`, updatedAt: new Date() }).where(eq(zendeskImport.id, 1))
  return true
}

export async function importedReadOnly(tx: Pick<Tx, "select">, ticketId: string): Promise<boolean> {
  const [row] = await tx.select({ zendeskId: ticket.zendeskId }).from(ticket).where(eq(ticket.id, ticketId))
  if (row?.zendeskId === null || row?.zendeskId === undefined) return false
  return (await finishedAt(tx)) === null
}

export async function refuseImported(tx: Pick<Tx, "select">, ticketId: string): Promise<void> {
  if (await importedReadOnly(tx, ticketId)) throw new Refusal("ticket_imported", 409)
}

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
