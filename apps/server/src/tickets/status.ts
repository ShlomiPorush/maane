import { mayChangeStatus, TICKET_STATUSES, type TicketStatus } from "@maane/shared"
import { eq } from "drizzle-orm"
import { type Actor, writeAudit } from "../audit.ts"
import type { Db } from "../db/client.ts"
import { ticket } from "../db/schema.ts"
import { Refusal } from "../organizations/refusal.ts"
import { endWaitingPeriod } from "../reminders/periods.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export type LockedTicket = { id: string; number: number; status: TicketStatus; organizationId: string }

export type StatusVia = "agent" | "reply" | "customer_reply" | "snooze"

export type StatusActor = { role: string; actor: Actor; ipAddress: string | null } | { role: "system"; actor: Actor }

const asStatus = (value: string): TicketStatus =>
  (TICKET_STATUSES as readonly string[]).includes(value) ? (value as TicketStatus) : "open"

export async function lockTicket(tx: Pick<Tx, "select">, id: string): Promise<LockedTicket | null> {
  const [row] = await tx
    .select({ id: ticket.id, number: ticket.number, status: ticket.status, organizationId: ticket.organizationId })
    .from(ticket)
    .where(eq(ticket.id, id))
    .for("update")
  return row ? { ...row, status: asStatus(row.status) } : null
}

export async function changeStatus(
  tx: Pick<Tx, "select" | "update" | "insert">,
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
  if (locked.status === "pending") await endWaitingPeriod(tx, locked.id, "status_change")
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
