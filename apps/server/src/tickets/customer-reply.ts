import type { TicketStatus } from "@maane/shared"
import { and, eq, type SQL, sql } from "drizzle-orm"
import { cancelTicketActions } from "../actions/timed.ts"
import { SYSTEM } from "../audit.ts"
import type { Db } from "../db/client.ts"
import { intakeRecord, ticket, timedAction } from "../db/schema.ts"
import { endWaitingPeriod } from "../reminders/periods.ts"
import { customerEndsSnooze } from "./snooze.ts"
import { changeStatus, lockTicket } from "./status.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export type IntakeFacts = {
  outcome: string
  classification?: string | null
  ticketId?: string | null
}

export function isCustomerReply(record: IntakeFacts): boolean {
  return record.outcome === "joined" && record.classification === "customer" && typeof record.ticketId === "string"
}

export function customerReplyCondition(record: typeof intakeRecord = intakeRecord): SQL {
  return sql`(${and(eq(record.outcome, "joined"), eq(record.classification, "customer"))} and ${record.ticketId} is not null)`
}

export async function customerWroteSince(tx: Pick<Tx, "select">, ticketId: string, actionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(intakeRecord)
    .innerJoin(timedAction, eq(timedAction.id, actionId))
    .where(
      and(
        eq(intakeRecord.ticketId, ticketId),
        customerReplyCondition(),
        sql`${intakeRecord.createdAt} > ${timedAction.createdAt}`,
      ),
    )
    .limit(1)
  return row !== undefined
}

export function statusAfterCustomerReply(status: TicketStatus): TicketStatus {
  return status === "closed" ? "closed" : "open"
}

export async function customerReplied(tx: Tx, ticketId: string, at: Date): Promise<void> {
  const locked = await lockTicket(tx, ticketId)
  if (!locked) throw new Error("a customer reply's ticket does not exist")
  await endWaitingPeriod(tx, ticketId, "customer_reply")
  await changeStatus(
    tx,
    locked,
    statusAfterCustomerReply(locked.status),
    { role: "system", actor: SYSTEM },
    "customer_reply",
  )
  await tx.update(ticket).set({ lastActivityAt: at }).where(eq(ticket.id, ticketId))
  await cancelTicketActions(tx, ticketId, "customer_reply")
  await customerEndsSnooze(tx, locked)
}
