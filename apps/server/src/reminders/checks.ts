// Whether a reminder still applies (plan 4.3), checked by its job at its time (apps/worker/src/actions/run.ts) and again
// by the send point's claim in the transaction that hands its outbox row to `sending` (apps/worker/src/send/sender.ts),
// both after they locked the action: every ending of its waiting period cancels the action in its own transaction
// (periods.ts), and these checks find each ending again from the rows themselves. Send again of a reminder that failed
// for certain is checked the same way, when it is asked for and again by the claim of its new attempt. Kept free of sharp.

import { type ActionReason, FAILED_DELIVERY_STATUSES, type TicketStatus } from "@maane/shared"
import { and, eq, inArray } from "drizzle-orm"
import { actionPassed } from "../actions/timed.ts"
import type { Db } from "../db/client.ts"
import { outboxRecipient, reminder, waitingPeriod } from "../db/schema.ts"
import { customerWroteSince } from "../tickets/customer-reply.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/**
 * Why a locked reminder must not go now, or null: its period ended, the ticket is no longer pending, the customer wrote
 * since the reminder was made (the one definition of a customer reply), or the reply that started the period bounced,
 * was rejected, or was reported as spam.
 */
export async function reminderProblem(
  tx: Pick<Tx, "select">,
  actionId: string,
  held: { id: string; status: TicketStatus },
): Promise<ActionReason | null> {
  const [period] = await tx
    .select({ messageId: waitingPeriod.messageId, endReason: waitingPeriod.endReason })
    .from(reminder)
    .innerJoin(waitingPeriod, eq(waitingPeriod.id, reminder.periodId))
    .where(eq(reminder.actionId, actionId))
  if (!period) throw new Error("the reminder's waiting period was not found")
  if (period.endReason) return period.endReason as ActionReason
  if (held.status !== "pending") return "status_change"
  if (await customerWroteSince(tx, held.id, actionId)) return "customer_reply"
  if (period.messageId) {
    const [failed] = await tx
      .select({ address: outboxRecipient.address })
      .from(outboxRecipient)
      .where(
        and(
          eq(outboxRecipient.messageId, period.messageId),
          inArray(outboxRecipient.delivery, [...FAILED_DELIVERY_STATUSES]),
        ),
      )
      .limit(1)
    if (failed) return "delivery_failed"
  }
  return null
}

/**
 * Whether Send again may send a reminder again: its outbox row failed for certain (no provider accepted it, never an
 * unknown fate, which may have reached the customer) after the reminder passed its checks at the send point, and its
 * waiting period still holds as reminderProblem reads it. Otherwise it is never sent again.
 */
export async function reminderMayGoAgain(
  tx: Pick<Tx, "select">,
  sent: { state: string; actionVersion: number | null },
  action: { id: string; state: string; version: number } | null,
  held: { id: string; status: TicketStatus },
): Promise<boolean> {
  if (sent.state !== "failed" || !action || !actionPassed(action, sent.actionVersion)) return false
  return (await reminderProblem(tx, action.id, held)) === null
}
