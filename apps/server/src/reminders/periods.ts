// Waiting periods and their reminders (plan 4.3). A period starts when an agent's reply that sets the ticket to pending
// goes to sending: in the server's transaction for a reply sent now, and in the send point's claim for a scheduled
// reply (apps/worker/src/send/sender.ts), the same moment "Send and set pending" applies. When the ticket's
// organization has a reminder template, the period gets its reminder: a timed action of the kind `reminder` (one rule
// for every timed action, apps/server/src/actions/timed.ts), due the organization's number of days later, with its
// `timed-action` job queued for that time in the same transaction.
//
// A period ends on a customer reply, a status change away from pending, a new agent reply, a move to another
// organization, or a bounce, rejection, or spam report on the reply that started it, each in its own transaction, which
// holds the ticket locked: its reminder, if it has not gone to the send point, is cancelled with the same reason. The
// reminder's job and the send point's claim check every ending again (checks.ts), after they locked the action.
//
// A move to another organization (plan 4.1) ends the period and, when Maane started it, starts a new one for the same
// reply at once: its reminder is the new organization's, due its number of days from the move, its template read at
// send time; none when the new organization has no template. An imported period only ends.
//
// Lock order: the ticket, then the reminder's action, then the period row. Kept free of sharp: the worker loads it.

import type { PeriodEndReason } from "@maane/shared"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { OPEN_ACTION_STATES } from "../actions/timed.ts"
import type { Db } from "../db/client.ts"
import { organization, reminder, ticket, timedAction, waitingPeriod } from "../db/schema.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** Queues a reminder's `timed-action` job for its time, in the caller's transaction. */
export type QueueReminder = (data: { actionId: string; version: number }, startAfter: Date) => Promise<unknown>

/**
 * Ends the ticket's open waiting period, if any, and cancels its reminder that has not gone to the send point, in the
 * caller's transaction, which holds the ticket locked. With `startedBy`, only a period one of those replies started
 * ends (a bounce on the reply that started it). Returns whether a period ended.
 */
export async function endWaitingPeriod(
  tx: Pick<Tx, "select" | "update">,
  ticketId: string,
  reason: PeriodEndReason,
  startedBy?: readonly string[],
): Promise<boolean> {
  const [open] = await tx
    .select({ id: waitingPeriod.id, messageId: waitingPeriod.messageId })
    .from(waitingPeriod)
    .where(and(eq(waitingPeriod.ticketId, ticketId), isNull(waitingPeriod.endedAt)))
  if (!open || (startedBy && !(open.messageId && startedBy.includes(open.messageId)))) return false
  // The reminder's action first, as the job and the claim lock it before they read the period.
  await tx
    .update(timedAction)
    .set({ state: "cancelled", reason, updatedAt: sql`now()` })
    .where(
      and(
        inArray(
          timedAction.id,
          tx.select({ id: reminder.actionId }).from(reminder).where(eq(reminder.periodId, open.id)),
        ),
        inArray(timedAction.state, [...OPEN_ACTION_STATES]),
      ),
    )
  await tx
    .update(waitingPeriod)
    .set({ endedAt: sql`now()`, endReason: reason })
    .where(and(eq(waitingPeriod.id, open.id), isNull(waitingPeriod.endedAt)))
  return true
}

/**
 * Starts a waiting period for the reply `messageId` that set the ticket to pending, in the caller's transaction, which
 * holds the ticket locked; an open period ends first (a new agent reply). When the organization has a reminder
 * template, its reminder is made, due its number of days from now by the database's clock, and its job queued for that
 * same time. Returns the period's ID and the reminder's, if any.
 */
export async function startWaitingPeriod(
  tx: Pick<Tx, "select" | "update" | "insert">,
  ticketId: string,
  messageId: string,
  queue: QueueReminder,
): Promise<{ periodId: string; actionId: string | null }> {
  await endWaitingPeriod(tx, ticketId, "agent_reply")
  return openWaitingPeriod(tx, ticketId, messageId, queue)
}

/**
 * Ends the ticket's open waiting period for a move, in the move's transaction, which holds the ticket locked: its
 * reminder was the old organization's. Returns the reply that started it when Maane started it, for which the move
 * then opens a new period (openWaitingPeriod) once it set the new organization; null for no period or an imported
 * one, which never sends.
 */
export async function endWaitingPeriodForMove(
  tx: Pick<Tx, "select" | "update">,
  ticketId: string,
): Promise<string | null> {
  const [open] = await tx
    .select({ origin: waitingPeriod.origin, messageId: waitingPeriod.messageId })
    .from(waitingPeriod)
    .where(and(eq(waitingPeriod.ticketId, ticketId), isNull(waitingPeriod.endedAt)))
  if (!open) return null
  await endWaitingPeriod(tx, ticketId, "move")
  return open.origin === "maane" ? open.messageId : null
}

/**
 * A new open period for the reply `messageId`, in the caller's transaction, which holds the ticket locked and has no
 * open period: when the ticket's organization has a reminder template, its reminder is made, due its number of days
 * from now by the database's clock, and its job queued for that same time.
 */
export async function openWaitingPeriod(
  tx: Pick<Tx, "select" | "insert">,
  ticketId: string,
  messageId: string,
  queue: QueueReminder,
): Promise<{ periodId: string; actionId: string | null }> {
  const [settings] = await tx
    .select({ template: organization.reminderTemplate, days: organization.reminderDays })
    .from(ticket)
    .innerJoin(organization, eq(organization.id, ticket.organizationId))
    .where(eq(ticket.id, ticketId))
  const [period] = await tx
    .insert(waitingPeriod)
    .values({ ticketId, origin: "maane", messageId })
    .returning({ id: waitingPeriod.id })
  if (!period) throw new Error("a waiting period was not written")
  // No template: no reminder for this organization (its period is still recorded).
  if (!settings || settings.template.trim() === "") return { periodId: period.id, actionId: null }
  const [action] = await tx
    .insert(timedAction)
    .values({
      kind: "reminder",
      ticketId,
      dueAt: sql`now() + make_interval(days => ${settings.days})`,
    })
    .returning({ id: timedAction.id, version: timedAction.version, dueAt: timedAction.dueAt })
  if (!action) throw new Error("a reminder was not written")
  await tx.insert(reminder).values({ actionId: action.id, periodId: period.id })
  // The job's time is the action's own, as the database wrote it.
  await queue({ actionId: action.id, version: action.version }, action.dueAt)
  return { periodId: period.id, actionId: action.id }
}
