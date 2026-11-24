import {
  DELIVERY_DETAIL_MAX,
  type DeliverySource,
  type DeliveryStatus,
  FAILED_DELIVERY_STATUSES,
  FINAL_DELIVERY_STATUSES,
  type TicketFlag,
} from "@maane/shared"
import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { message, outbox, outboxRecipient, ticket } from "../db/schema.ts"
import { endWaitingPeriod } from "../reminders/periods.ts"
import { wellFormed, wellFormedText } from "../text.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export interface DeliveryEvent {
  recipient: string
  status: DeliveryStatus
  at: Date
  detail: string | null
  source: DeliverySource
}

export type DeliveryTarget =
  | { providerId: string }
  | { messageId: string; acceptedBefore: Date }
  | { messageId: string; onlyAttempt: true }

const FLAG: TicketFlag = "delivery_failed"

export function queueIdOf(response: string | null): string | null {
  const match = /(?:^|\s)id=([A-Za-z0-9._-]{1,100})(?:\s|$)/.exec(response ?? "")
  return match?.[1] ?? null
}

export function detailOf(value: unknown): string | null {
  if (typeof value !== "string") return null
  const text = wellFormedText(value.trim()).value.slice(0, DELIVERY_DETAIL_MAX)
  return text === "" ? null : text
}

const ISO_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(Z|[+-]\d{2}:?\d{2})?$/i

export function eventTime(value: unknown): Date | null {
  if (typeof value === "number" || (typeof value === "string" && /^\d{9,11}(?:\.\d+)?$/.test(value.trim()))) {
    const seconds = Number(value)
    if (!Number.isFinite(seconds) || seconds < 1e9 || seconds > 1e11) return null
    return new Date(Math.round(seconds * 1000))
  }
  if (typeof value !== "string") return null
  const match = ISO_TIME.exec(value.trim())
  if (!match) return null
  const zone = match[3] ? match[3].toUpperCase().replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") : "Z"
  const time = new Date(`${match[1]}T${match[2]}${zone}`)
  return Number.isNaN(time.getTime()) ? null : time
}

export async function applyDeliveryEvent(tx: Tx, target: DeliveryTarget, event: DeliveryEvent): Promise<boolean> {
  const final = FINAL_DELIVERY_STATUSES.includes(event.status)
  const which =
    "providerId" in target
      ? and(eq(outboxRecipient.providerId, target.providerId), eq(outboxRecipient.provider, "smtp2go"))
      : "acceptedBefore" in target
        ? and(
            eq(outboxRecipient.messageId, target.messageId),
            eq(outboxRecipient.state, "accepted"),
            lt(outboxRecipient.acceptedAt, target.acceptedBefore),
          )
        : and(
            eq(outboxRecipient.messageId, target.messageId),
            isNull(outboxRecipient.providerId),
            eq(outboxRecipient.possibleSends, 1),
          )
  const newer = or(
    isNull(outboxRecipient.deliveryAt),
    lt(outboxRecipient.deliveryAt, event.at),
    final
      ? and(
          eq(outboxRecipient.deliveryAt, event.at),
          notInArray(outboxRecipient.delivery, [...FINAL_DELIVERY_STATUSES]),
        )
      : sql`false`,
  )
  if (event.status === "delivered")
    await tx
      .update(outboxRecipient)
      .set({ firstDeliveredAt: event.at })
      .where(and(which, eq(outboxRecipient.address, event.recipient), isNull(outboxRecipient.firstDeliveredAt)))
  const changed = await tx
    .update(outboxRecipient)
    .set({
      delivery: event.status,
      deliveryAt: event.at,
      deliveryDetail: event.detail,
      deliverySource: event.source,
      deliveryRecordedAt: sql`now()`,
    })
    .where(and(which, eq(outboxRecipient.address, event.recipient), newer))
    .returning({ messageId: outboxRecipient.messageId })
  if (changed.length === 0) return false
  const tickets = await tx
    .selectDistinct({ ticketId: message.ticketId })
    .from(message)
    .where(
      inArray(
        message.id,
        changed.map((row) => row.messageId),
      ),
    )
  const failed = FAILED_DELIVERY_STATUSES.includes(event.status)
  for (const row of tickets) {
    if (!row.ticketId) continue
    await refreshDeliveryFlag(tx, row.ticketId)
    if (failed)
      await endWaitingPeriod(
        tx,
        row.ticketId,
        "delivery_failed",
        changed.map((entry) => entry.messageId),
      )
  }
  return true
}

export async function refreshDeliveryFlag(tx: Tx, ticketId: string): Promise<void> {
  const [row] = await tx
    .select({ flags: ticket.reviewFlags })
    .from(ticket)
    .where(eq(ticket.id, ticketId))
    .for("no key update")
  if (!row) return
  const failed = FAILED_DELIVERY_STATUSES.map((status) => sql`${status}`)
  const result = await tx.execute<{ failed: boolean }>(sql`
    select exists (
      select 1 from (
        select distinct on (r.address) r.delivery, r.delivery_recorded_at, r.accepted_at
        from ${outboxRecipient} r
        join ${message} m on m.id = r.message_id
        where m.ticket_id = ${ticketId} and r.state = 'accepted'
        order by r.address, r.accepted_at desc, m.received_at desc, m.id desc
      ) latest
      where latest.delivery in (${sql.join(failed, sql`, `)})
        and latest.delivery_recorded_at >= latest.accepted_at
    ) as failed`)
  const flagged = result.rows[0]?.failed === true
  if (flagged === row.flags.includes(FLAG)) return
  const flags = flagged ? [...row.flags, FLAG] : row.flags.filter((flag) => flag !== FLAG)
  await tx.update(ticket).set({ reviewFlags: flags }).where(eq(ticket.id, ticketId))
}

export interface WebhookEvent {
  providerId: string
  messageId: string | null
  event: DeliveryEvent
}

export async function applyWebhookEvent(
  tx: Tx,
  { providerId, messageId, event }: WebhookEvent,
): Promise<"applied" | "unchanged" | "unmatched" | "dropped"> {
  const [known] = await tx
    .select({ messageId: outboxRecipient.messageId })
    .from(outboxRecipient)
    .where(and(eq(outboxRecipient.providerId, providerId), eq(outboxRecipient.provider, "smtp2go")))
    .limit(1)
  if (known) return (await applyDeliveryEvent(tx, { providerId }, event)) ? "applied" : "unchanged"
  if (!messageId) return "dropped"
  const [reply] = await tx
    .select({ messageId: outbox.messageId })
    .from(outbox)
    .where(eq(outbox.messageIdHeader, messageId))
  if (!reply) return "dropped"
  const [recipient] = await tx
    .select({ providerId: outboxRecipient.providerId, possibleSends: outboxRecipient.possibleSends })
    .from(outboxRecipient)
    .where(and(eq(outboxRecipient.messageId, reply.messageId), eq(outboxRecipient.address, event.recipient)))
  if (recipient && recipient.providerId === null && recipient.possibleSends === 1) {
    const applied = await applyDeliveryEvent(tx, { messageId: reply.messageId, onlyAttempt: true }, event)
    return applied ? "applied" : "unchanged"
  }
  await recordUnmatched(tx, reply.messageId, {
    source: event.source,
    status: event.status,
    at: event.at,
    recipient: event.recipient,
    messageId,
  })
  return "unmatched"
}

export interface UnmatchedEvent {
  source: DeliverySource
  status: DeliveryStatus
  at: Date
  recipient: string | null
  messageId: string | null
}

export async function recordUnmatched(tx: Tx, messageId: string, event: UnmatchedEvent): Promise<void> {
  const details = {
    status: event.status,
    at: event.at.toISOString(),
    recipient: event.recipient?.slice(0, 254) ?? null,
    messageId: event.messageId?.slice(0, 998) ?? null,
  }
  await tx
    .update(outbox)
    .set({
      unmatchedDeliveryAt: sql`now()`,
      unmatchedDeliverySource: event.source,
      unmatchedDeliveryEvent: wellFormed(details).value,
    })
    .where(eq(outbox.messageId, messageId))
}

function webhookStatus(event: unknown, bounce: unknown): DeliveryStatus | null {
  if (event === "delivered") return "delivered"
  if (event === "bounce") return bounce === "soft" ? "soft_bounce" : "hard_bounce"
  if (event === "reject") return "rejected"
  if (event === "spam") return "spam"
  return null
}

export function webhookEvents(payload: unknown): WebhookEvent[] {
  const items = Array.isArray(payload) ? payload.slice(0, 100) : [payload]
  const events: WebhookEvent[] = []
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue
    const fields = item as Record<string, unknown>
    const status = webhookStatus(fields.event, fields.bounce)
    const providerId = typeof fields.email_id === "string" ? fields.email_id.trim() : ""
    const recipient = typeof fields.rcpt === "string" ? fields.rcpt.trim().toLowerCase() : ""
    const at = eventTime(fields.time)
    if (!status || !at || !/^[A-Za-z0-9._-]{1,100}$/.test(providerId) || !recipient || recipient.length > 254) continue
    const named = typeof fields["message-id"] === "string" ? fields["message-id"].trim().replace(/^<(.*)>$/, "$1") : ""
    events.push({
      providerId,
      messageId: named && named.length <= 998 && !/\s/.test(named) ? named : null,
      event: {
        recipient,
        status,
        at,
        detail: status === "delivered" ? null : detailOf(fields.message),
        source: "webhook",
      },
    })
  }
  return events
}

export const ACTIVITY_EVENTS: Readonly<Record<string, DeliveryStatus>> = {
  delivered: "delivered",
  "soft-bounced": "soft_bounce",
  "hard-bounced": "hard_bounce",
  rejected: "rejected",
  spam: "spam",
}
