import type { PeriodEndReason } from "@maane/shared"
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm"
import { OPEN_ACTION_STATES } from "../actions/timed.ts"
import type { Db } from "../db/client.ts"
import { organization, reminder, ticket, timedAction, waitingPeriod } from "../db/schema.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export type QueueReminder = (data: { actionId: string; version: number }, startAfter: Date) => Promise<unknown>

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
  const reminders = tx.select({ id: reminder.actionId }).from(reminder).where(eq(reminder.periodId, open.id))
  await tx.select({ id: timedAction.id }).from(timedAction).where(inArray(timedAction.id, reminders)).for("update")
  await tx
    .update(timedAction)
    .set({ state: "cancelled", reason, updatedAt: sql`now()` })
    .where(and(inArray(timedAction.id, reminders), inArray(timedAction.state, [...OPEN_ACTION_STATES])))
  await tx
    .update(waitingPeriod)
    .set({ endedAt: sql`now()`, endReason: reason })
    .where(and(eq(waitingPeriod.id, open.id), isNull(waitingPeriod.endedAt)))
  return true
}

export async function startWaitingPeriod(
  tx: Pick<Tx, "select" | "update" | "insert">,
  ticketId: string,
  messageId: string,
  queue: QueueReminder,
): Promise<{ periodId: string; actionId: string | null }> {
  await endWaitingPeriod(tx, ticketId, "agent_reply")
  return openWaitingPeriod(tx, ticketId, messageId, queue)
}

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

export function reminderDueAt(days: number, from: SQL = sql`now()`): SQL {
  return sql`date_add(${from}, make_interval(days => ${days}), 'Asia/Jerusalem')`
}

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
  if (!settings || settings.template.trim() === "") return { periodId: period.id, actionId: null }
  const [action] = await tx
    .insert(timedAction)
    .values({
      kind: "reminder",
      ticketId,
      dueAt: reminderDueAt(settings.days),
    })
    .returning({ id: timedAction.id, version: timedAction.version, dueAt: timedAction.dueAt })
  if (!action) throw new Error("a reminder was not written")
  await tx.insert(reminder).values({ actionId: action.id, periodId: period.id })
  await queue({ actionId: action.id, version: action.version }, action.dueAt)
  return { periodId: period.id, actionId: action.id }
}
