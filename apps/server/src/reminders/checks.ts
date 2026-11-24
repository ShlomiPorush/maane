import { type ActionReason, FAILED_DELIVERY_STATUSES, type TicketStatus } from "@maane/shared"
import { and, eq, inArray } from "drizzle-orm"
import { actionPassed } from "../actions/timed.ts"
import type { Db } from "../db/client.ts"
import { outboxRecipient, reminder, waitingPeriod } from "../db/schema.ts"
import { customerWroteSince } from "../tickets/customer-reply.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

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

export async function reminderMayGoAgain(
  tx: Pick<Tx, "select">,
  sent: { state: string; actionVersion: number | null },
  action: { id: string; state: string; version: number } | null,
  held: { id: string; status: TicketStatus },
): Promise<boolean> {
  if (sent.state !== "failed" || !action || !actionPassed(action, sent.actionVersion)) return false
  return (await reminderProblem(tx, action.id, held)) === null
}
