import { message, outbox, outboxRecipient } from "@maane/server/db/schema"
import { applyDeliveryEvent, recordUnmatched } from "@maane/server/delivery/service"
import { and, eq, lt } from "drizzle-orm"
import type { Tx } from "../files/types.ts"

type MessageRow = typeof message.$inferSelect

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
  const recipients = msg.deliveryReport
  const failed = recipients.filter((entry) => entry.action === "failed")
  if (recipients.length > 0 && failed.length === 0) return reply
  const before = new Set(
    (
      await tx
        .select({ address: outboxRecipient.address })
        .from(outboxRecipient)
        .where(
          and(
            eq(outboxRecipient.messageId, reply.messageId),
            eq(outboxRecipient.state, "accepted"),
            lt(outboxRecipient.acceptedAt, msg.receivedAt),
          ),
        )
    ).map((row) => row.address),
  )
  const named = failed.filter((entry) => before.has(entry.address))
  const unnamed = failed.filter((entry) => !before.has(entry.address))
  if (failed.length === 0 || unnamed.length > 0)
    await recordUnmatched(tx, reply.messageId, {
      source: "report",
      status: "hard_bounce",
      at: msg.receivedAt,
      recipient: unnamed[0]?.address ?? null,
      messageId: msg.reportOriginalMessageId,
    })
  for (const entry of named)
    await applyDeliveryEvent(
      tx,
      { messageId: reply.messageId, acceptedBefore: msg.receivedAt },
      { recipient: entry.address, status: "hard_bounce", at: msg.receivedAt, detail: entry.status, source: "report" },
    )
  return reply
}
