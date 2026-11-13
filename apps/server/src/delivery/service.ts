// Delivery status (plan 3.3): what a recipient's mail server did with a reply a provider accepted. Three sources write
// it, all through applyDeliveryEvent: SMTP2GO's webhook (server), SMTP2GO's activity search (worker), and a delivery
// report of the failover server in the intake mailbox (worker). They only change delivery information: nothing here
// sends, permits, or blocks a send.
//
// - SMTP2GO's events find their recipient by SMTP2GO's queue ID (kept from its final 250 when it accepted the reply) and
//   the recipient's address. When no recipient holds that ID (the connection dropped after the data, or a run stopped
//   before it stored the ID), a webhook event finds it by Maane's own Message-ID, which the event carries, and the
//   address, but only while exactly one attempt could have reached that recipient (possible_sends) and no queue ID was
//   stored for it; otherwise the event is recorded on the reply as unmatched. An event for a reply Maane does not know
//   is dropped. A status written this way on an `unknown` recipient is shown beside it; the send state stays the
//   agent's to decide.
// - An older event never overwrites a newer one: the UPDATE itself only takes an event whose time is later than the
//   one the recipient holds (at the same time, only a final status over one that is not), so duplicates, late
//   retries, and events out of order change nothing. A send's result writes other columns and never these.
// - The ticket's `delivery_failed` flag follows from the rows (refreshDeliveryFlag): for each address, the recipient row
//   of the ticket accepted last (by when it was accepted, not when its reply was written) decides; the flag is set while
//   that row holds a bounce, a rejection, or a spam report written after its acceptance. A later accepted send to the
//   same address clears it, and an old bounce of an earlier send never sets it again.

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
import { wellFormedText } from "../text.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** One event about one recipient. */
export interface DeliveryEvent {
  /** In lower case. */
  recipient: string
  status: DeliveryStatus
  /** When it happened, by the provider's or the report's time. */
  at: Date
  detail: string | null
  source: DeliverySource
}

/**
 * Which recipient an event is about:
 * - `providerId`: SMTP2GO's queue ID.
 * - `acceptedBefore`: a reply's recipient accepted before this time (a report in the intake mailbox, received then).
 * - `onlyAttempt`: a reply's recipient without a queue ID that exactly one attempt could have reached (an SMTP2GO
 *   event matched by Maane's Message-ID).
 */
export type DeliveryTarget =
  | { providerId: string }
  | { messageId: string; acceptedBefore: Date }
  | { messageId: string; onlyAttempt: true }

const FLAG: TicketFlag = "delivery_failed"

/**
 * SMTP2GO's queue ID in its final reply to the data (`250 OK id=<queue id>`), the `email_id` its webhook and activity
 * search name. Null when the reply carries none.
 */
export function queueIdOf(response: string | null): string | null {
  const match = /(?:^|\s)id=([A-Za-z0-9._-]{1,100})(?:\s|$)/.exec(response ?? "")
  return match?.[1] ?? null
}

/** A provider's text, bounded and well formed, or null. */
export function detailOf(value: unknown): string | null {
  if (typeof value !== "string") return null
  const text = wellFormedText(value.trim()).value.slice(0, DELIVERY_DETAIL_MAX)
  return text === "" ? null : text
}

const ISO_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(Z|[+-]\d{2}:?\d{2})?$/i

/**
 * An event's time as SMTP2GO gives it (documented as UTC, its format not shown): an ISO 8601 or RFC 3339 time, with or
 * without a zone (none reads as UTC), or Unix seconds. Anything else is no time, and the event is dropped: an event
 * Maane cannot order must never overwrite one it can.
 */
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

/**
 * Writes one event to its recipient when it is newer than what the recipient holds, and refreshes the ticket's flag.
 * Returns whether a recipient changed; an event for an unknown reply or recipient changes nothing.
 */
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
  for (const row of tickets) if (row.ticketId) await refreshDeliveryFlag(tx, row.ticketId)
  return true
}

/**
 * Sets or clears the ticket's `delivery_failed` flag from its replies' recipients. The ticket row is locked first (FOR
 * NO KEY UPDATE, which a participant's foreign key check does not wait for), so two writers refresh one after the
 * other and the last one reads what both wrote.
 */
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
        order by r.address, r.accepted_at desc nulls last, m.received_at desc, m.id desc
      ) latest
      where latest.delivery in (${sql.join(failed, sql`, `)})
        and (latest.accepted_at is null or latest.delivery_recorded_at >= latest.accepted_at)
    ) as failed`)
  const flagged = result.rows[0]?.failed === true
  if (flagged === row.flags.includes(FLAG)) return
  const flags = flagged ? [...row.flags, FLAG] : row.flags.filter((flag) => flag !== FLAG)
  await tx.update(ticket).set({ reviewFlags: flags }).where(eq(ticket.id, ticketId))
}

/** One webhook event: SMTP2GO's queue ID, Maane's own Message-ID when the event carries it, and what happened. */
export interface WebhookEvent {
  providerId: string
  messageId: string | null
  event: DeliveryEvent
}

/**
 * Applies one webhook event: by its queue ID when a recipient holds it; else by Maane's Message-ID and the address,
 * only for a recipient exactly one attempt could have reached and no queue ID was stored for; else, for one of Maane's
 * replies, recorded on the reply as unmatched. An event for a reply Maane does not know is dropped.
 */
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
  await recordUnmatched(tx, reply.messageId, event.source)
  return "unmatched"
}

/** Records on a reply that a delivery event about it could not be tied to one recipient's send; changes nothing else. */
export async function recordUnmatched(tx: Tx, messageId: string, source: DeliverySource): Promise<void> {
  await tx
    .update(outbox)
    .set({ unmatchedDeliveryAt: sql`now()`, unmatchedDeliverySource: source })
    .where(eq(outbox.messageId, messageId))
}

/** SMTP2GO's webhook events Maane reads (its documented `event` values), and the status each one means. */
function webhookStatus(event: unknown, bounce: unknown): DeliveryStatus | null {
  if (event === "delivered") return "delivered"
  if (event === "bounce") return bounce === "soft" ? "soft_bounce" : "hard_bounce"
  if (event === "reject") return "rejected"
  if (event === "spam") return "spam"
  return null
}

/**
 * The events of one webhook request (SMTP2GO posts one event, as a form or as JSON; an array is read item by item):
 * those Maane reads, with an `email_id`, a recipient, and a time it can read. Everything else is dropped.
 */
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
    // Maane's own Message-ID, as SMTP2GO passes the header on (with or without its angle brackets).
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

/** SMTP2GO's activity search events Maane reads (its documented `event_types`), and the status each one means. */
export const ACTIVITY_EVENTS: Readonly<Record<string, DeliveryStatus>> = {
  delivered: "delivered",
  "soft-bounced": "soft_bounce",
  "hard-bounced": "hard_bounce",
  rejected: "rejected",
  spam: "spam",
}
