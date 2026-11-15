// What a customer reply is, in one place (plan 4.1), for every part of the workflow that reacts to one: the status here,
// and later the end of a snooze, a scheduled reply cancelled, a reminder's waiting period ended (plans 4.2, 4.3), and the
// browser notification (plan 4.5).
//
// A customer reply is an incoming message that intake, in live mode, attached to an existing ticket as the customer's
// mail: its intake record says `joined`, `live`, and `customer`. Everything else is never one: automated mail as
// classification decides it at stage one (delivery status notifications, failover bounces, read receipts, out-of-office
// replies, mailing lists: outcome `automated`), Maane's own mail coming back and a copy of an earlier message (outcome
// `copy`), a message that opened a ticket (`new_ticket`, `new_linked_ticket`, among them a reply to a closed ticket,
// which opens a follow-up and leaves the closed ticket as it is), and everything listening mode records (its shadow
// conversations, and a ticket it would have joined, which it never changes).

import type { TicketStatus } from "@maane/shared"
import { and, eq, type SQL, sql } from "drizzle-orm"
import { cancelTicketActions } from "../actions/timed.ts"
import { SYSTEM } from "../audit.ts"
import type { Db } from "../db/client.ts"
import { intakeRecord, ticket, timedAction } from "../db/schema.ts"
import { customerEndsSnooze } from "./snooze.ts"
import { changeStatus, lockTicket } from "./status.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** An intake record's facts that decide whether its message is a customer reply. */
export type IntakeFacts = {
  mode: string
  outcome: string
  classification?: string | null
  ticketId?: string | null
}

/** Whether intake recorded this message as a customer reply to an existing ticket. */
export function isCustomerReply(record: IntakeFacts): boolean {
  return (
    record.mode === "live" &&
    record.outcome === "joined" &&
    record.classification === "customer" &&
    typeof record.ticketId === "string"
  )
}

/** The same definition over stored intake records, for queries ("has the customer written since ..."). */
export function customerReplyCondition(record: typeof intakeRecord = intakeRecord): SQL {
  return sql`(${and(
    eq(record.mode, "live"),
    eq(record.outcome, "joined"),
    eq(record.classification, "customer"),
  )} and ${record.ticketId} is not null)`
}

/**
 * Whether the customer wrote to the ticket after this timed action was made (plan 4.2), by the definition above: a
 * customer reply's intake record newer than the action, both by the database's clock.
 */
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

/** The status a customer reply leaves: open, from every status but closed (a closed ticket gets a follow-up instead). */
export function statusAfterCustomerReply(status: TicketStatus): TicketStatus {
  return status === "closed" ? "closed" : "open"
}

/**
 * What a customer reply does to its ticket, in the transaction that attached the message: the ticket becomes open
 * (pending, on hold, solved, and new alike), audited as the system's change, and its last activity moves. Plan 4.2:
 * its scheduled replies that have not gone to the send point are cancelled, and its snooze ends.
 */
export async function customerReplied(tx: Tx, ticketId: string, at: Date): Promise<void> {
  const locked = await lockTicket(tx, ticketId)
  if (!locked) throw new Error("a customer reply's ticket does not exist")
  await changeStatus(
    tx,
    locked,
    statusAfterCustomerReply(locked.status),
    { role: "system", actor: SYSTEM },
    "customer_reply",
  )
  await tx.update(ticket).set({ lastActivityAt: at }).where(eq(ticket.id, ticketId))
  await cancelTicketActions(tx, ticketId, "customer_reply")
  await customerEndsSnooze(tx, ticketId)
}
