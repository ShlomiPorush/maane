// The one writer of a ticket's status (plan 4.1). The status control of the ticket view, the composer's "Send and set
// pending", and a customer reply in intake all change a status here, inside their own transaction, on the ticket row
// locked FOR UPDATE: the change is decided from the locked row, never from a row read before, and `closed` is set and
// left only by an admin (mayChangeStatus). Each real change writes its audit row in the same transaction; a change to
// the status the ticket already has writes nothing.

import { mayChangeStatus, TICKET_STATUSES, type TicketStatus } from "@maane/shared"
import { eq } from "drizzle-orm"
import { type Actor, writeAudit } from "../audit.ts"
import type { Db } from "../db/client.ts"
import { ticket } from "../db/schema.ts"
import { Refusal } from "../organizations/refusal.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** A ticket row locked for a change, with what a change needs to know. */
export type LockedTicket = { id: string; number: number; status: TicketStatus; organizationId: string }

/** How a status changed, for the audit row: the status control, the composer, or a customer reply. */
export type StatusVia = "agent" | "reply" | "customer_reply"

/** Who changes it: a user (with their role) or the system (intake). */
export type StatusActor = { role: string; actor: Actor; ipAddress: string | null } | { role: "system"; actor: Actor }

const asStatus = (value: string): TicketStatus =>
  (TICKET_STATUSES as readonly string[]).includes(value) ? (value as TicketStatus) : "open"

/** The ticket locked FOR UPDATE until the transaction ends, or null when it does not exist. */
export async function lockTicket(tx: Pick<Tx, "select">, id: string): Promise<LockedTicket | null> {
  const [row] = await tx
    .select({ id: ticket.id, number: ticket.number, status: ticket.status, organizationId: ticket.organizationId })
    .from(ticket)
    .where(eq(ticket.id, id))
    .for("update")
  return row ? { ...row, status: asStatus(row.status) } : null
}

/**
 * Changes a locked ticket's status, or refuses: only an admin sets or leaves `closed` (the system never does). Returns
 * whether the status changed. The ticket's last activity is the caller's to set.
 */
export async function changeStatus(
  tx: Pick<Tx, "update" | "insert">,
  locked: LockedTicket,
  to: TicketStatus,
  by: StatusActor,
  via: StatusVia,
): Promise<boolean> {
  if (locked.status === to) return false
  if (
    by.role === "system" ? locked.status === "closed" || to === "closed" : !mayChangeStatus(by.role, locked.status, to)
  )
    throw new Refusal("status_admin_only", 403)
  await tx.update(ticket).set({ status: to }).where(eq(ticket.id, locked.id))
  await writeAudit(tx, by.actor, {
    action: "ticket.status",
    entityType: "ticket",
    entityId: locked.id,
    details: { ticket: locked.number, from: locked.status, to, via },
    ipAddress: "ipAddress" in by ? by.ipAddress : null,
  })
  locked.status = to
  return true
}
