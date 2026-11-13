// Failover bounces (plan 3.3): the failover server's envelope sender is the bounce address, which reaches the intake
// mailbox, so its delivery status notifications arrive as automated mail. Stage two hands each one here:
//
// - The report is tied to Maane's reply by the original Message-ID intake keeps (parse.ts reportOriginal).
// - Its recipients were read at stage one (parse.ts deliveryReport, stored in message.delivery_report). Only a `failed`
//   action is a bounce: each failed recipient of the reply becomes `hard_bounce` at the report's receive time, through
//   the same applyDeliveryEvent as SMTP2GO's events (newer events only), which also refreshes the ticket's flag.
// - A report that says no accepted recipient of the reply failed by name (no recipient groups, or failed addresses that
//   are not the reply's accepted recipients) is recorded on the reply (outbox.report_without_recipient) and changes no recipient. A report of only
//   other actions (delayed, delivered, relayed, expanded) is no bounce and changes nothing.
// - A disposition notification (a read receipt) has no delivery report and is never a bounce.

import { message, outbox, outboxRecipient } from "@maane/server/db/schema"
import { applyDeliveryEvent } from "@maane/server/delivery/service"
import { and, eq } from "drizzle-orm"
import type { Tx } from "../files/types.ts"
import type { ReportRecipient } from "../intake/parse.ts"

type MessageRow = typeof message.$inferSelect

/** The stored report's recipients, each checked again (the column is JSON). */
function recipientsOf(value: unknown): ReportRecipient[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is ReportRecipient =>
      typeof entry?.address === "string" &&
      typeof entry?.action === "string" &&
      (entry?.status === null || typeof entry?.status === "string"),
  )
}

/**
 * Applies a delivery report to the reply it names. Returns the reply and its ticket when the report is about one of
 * Maane's replies (for the intake record), else null.
 */
export async function applyDeliveryReport(
  tx: Tx,
  msg: MessageRow,
): Promise<{ messageId: string; ticketId: string | null } | null> {
  if (msg.deliveryReport === null || !msg.reportOriginalMessageId) return null
  const [reply] = await tx
    .select({ messageId: outbox.messageId, ticketId: message.ticketId })
    .from(outbox)
    .innerJoin(message, eq(message.id, outbox.messageId))
    .where(eq(outbox.messageIdHeader, msg.reportOriginalMessageId))
  if (!reply) return null
  const recipients = recipientsOf(msg.deliveryReport)
  const failed = recipients.filter((entry) => entry.action === "failed")
  if (recipients.length > 0 && failed.length === 0) return reply
  // Only recipients a provider accepted (or an agent marked as sent), as SMTP2GO's events find only those: a bounce of
  // an attempt whose fate is unknown would otherwise stay on the recipient and flag the ticket once Send again succeeds.
  const ours = new Set(
    (
      await tx
        .select({ address: outboxRecipient.address })
        .from(outboxRecipient)
        .where(and(eq(outboxRecipient.messageId, reply.messageId), eq(outboxRecipient.state, "accepted")))
    ).map((row) => row.address),
  )
  const named = failed.filter((entry) => ours.has(entry.address))
  if (named.length === 0) {
    await tx.update(outbox).set({ reportWithoutRecipient: msg.id }).where(eq(outbox.messageId, reply.messageId))
    return reply
  }
  for (const entry of named)
    await applyDeliveryEvent(
      tx,
      { messageId: reply.messageId },
      { recipient: entry.address, status: "hard_bounce", at: msg.receivedAt, detail: entry.status, source: "report" },
    )
  return reply
}
