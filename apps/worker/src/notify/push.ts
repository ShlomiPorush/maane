// Browser notifications (plan 4.5), the `push-notify` job: one ticket event to the devices of every user who may see
// the ticket's organization, through web-push's documented sendNotification. Right before each device's send the job
// reads the subscription, its user, and the user's organizations again, in its own check: a subscription deleted
// meanwhile gets nothing; a disabled (banned) or deleted user's subscriptions are deleted and nothing is sent; a user
// no longer allowed on the organization gets nothing and keeps the subscriptions for the others. The
// user's `role` and `banned` are read through the Drizzle schema, as the send point of replies does (sender.ts); no
// session is read. A push service's 404 or 410 deletes that subscription. Each push goes only to an endpoint of the
// allow list, checked again right before it, with no redirect followed (web-push makes one HTTPS request and takes any
// answer outside 2xx as a failure). An endpoint, a key, and a push service's answer never reach a log.

import type { Agent } from "node:https"
import type { VapidKeys } from "@maane/server/config"
import type { Db } from "@maane/server/db/client"
import { authUser, message, pushSubscription, ticket } from "@maane/server/db/schema"
import type { PushJob, PushKind } from "@maane/server/jobs/queue"
import { errorFacts, log } from "@maane/server/log"
import { pushEndpointAllowed } from "@maane/server/notifications/push"
import { inScope, visibleOrganizations } from "@maane/server/organizations/scope"
import { type Locale, MESSAGES } from "@maane/shared"
import { and, eq } from "drizzle-orm"
import webpush from "web-push"

/** How long one push may take, from the connection to the push service's answer. */
export const PUSH_TIMEOUT_MS = 15_000
/** How long a push service keeps a notification for a device that is offline. */
export const PUSH_TTL_SECONDS = 24 * 60 * 60
/** The longest customer name a notification shows, in characters. */
export const NAME_MAX = 80

/** What the service worker receives: the words to show and the ticket's number, nothing else. */
export type PushPayload = { title: string; body: string; number: number }

export interface PushNotifierOptions {
  db: Db
  vapid: VapidKeys
  /** MAANE_PUBLIC_URL: its origin is the VAPID subject, which the push services require to be https. */
  publicUrl: URL
  /** Test code only: the stand-in push service's endpoints, and the agent that trusts its certificate. */
  endpointAllowed?: (endpoint: string) => boolean
  agent?: Agent
}

export type PushResult = { sent: number; removed: number; failed: number }

/** Control characters and the characters that reorder text: a customer's name must not rearrange the words. */
const hidden = (code: number) =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x61c ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069)

/**
 * The customer's display name as a notification shows it: nothing hidden, one line, at most NAME_MAX characters, and
 * nothing when it holds an address.
 */
export function shownName(name: string | null): string {
  if (!name) return ""
  // Line breaks and tabs become spaces first, so they still part the words they stood between.
  const spaced = name.replace(/[\t\n\v\f\r]/g, " ")
  const visible = [...spaced].filter((char) => !hidden(char.codePointAt(0) ?? 0)).join("")
  // A display name that holds an address ("dana@example.com" <dana@example.com>) is not shown: never an address.
  if (/\S@\S/.test(visible)) return ""
  return [...visible.replace(/\s+/g, " ").trim()].slice(0, NAME_MAX).join("").trim()
}

/** The notification of one ticket event in one language: the number and the customer's name, and only those. */
export function pushPayload(locale: Locale, kind: PushKind, number: number, name: string | null): PushPayload {
  const words = MESSAGES[locale].notifications.push
  const title = (kind === "new_ticket" ? words.newTicket : words.customerReply).replace("{number}", String(number))
  return { title, body: shownName(name), number }
}

export class PushNotifier {
  readonly #db: Db
  readonly #vapid: VapidKeys
  readonly #publicUrl: URL
  readonly #allowed: (endpoint: string) => boolean
  readonly #agent?: Agent

  constructor(options: PushNotifierOptions) {
    this.#db = options.db
    this.#vapid = options.vapid
    this.#publicUrl = options.publicUrl
    this.#allowed = options.endpointAllowed ?? pushEndpointAllowed
    this.#agent = options.agent
  }

  async notify(job: PushJob): Promise<PushResult> {
    const result: PushResult = { sent: 0, removed: 0, failed: 0 }
    // The push services require an https or mailto subject; a stack on http (development) sends nothing.
    if (this.#publicUrl.protocol !== "https:") {
      log.warn("browser notifications need an https MAANE_PUBLIC_URL; nothing was sent")
      return result
    }
    const [event] = await this.#db
      .select({ number: ticket.number, organizationId: ticket.organizationId, fromName: message.fromName })
      .from(message)
      .innerJoin(ticket, eq(ticket.id, message.ticketId))
      .where(and(eq(message.id, job.messageId), eq(ticket.id, job.ticketId)))
    if (!event) return result

    const devices = await this.#db.select({ id: pushSubscription.id }).from(pushSubscription)
    for (const { id } of devices) {
      // The device's own check, right before its send: the subscription is still there, its user is still active,
      // and still allowed on the organization. An earlier send may have taken long enough for any of them to change.
      const [device] = await this.#db
        .select({
          id: pushSubscription.id,
          userId: pushSubscription.userId,
          endpoint: pushSubscription.endpoint,
          p256dh: pushSubscription.p256dh,
          auth: pushSubscription.auth,
          locale: pushSubscription.locale,
        })
        .from(pushSubscription)
        .where(eq(pushSubscription.id, id))
      if (!device) continue
      const [user] = await this.#db
        .select({ id: authUser.id, role: authUser.role, banned: authUser.banned })
        .from(authUser)
        .where(eq(authUser.id, device.userId))
      if (!user || user.banned) {
        const gone = await this.#db
          .delete(pushSubscription)
          .where(eq(pushSubscription.userId, device.userId))
          .returning({ id: pushSubscription.id })
        result.removed += gone.length
        continue
      }
      const scope = await visibleOrganizations(this.#db, { id: user.id, role: user.role ?? "agent" })
      if (!inScope(scope, event.organizationId)) continue
      if (!this.#allowed(device.endpoint)) {
        result.failed++
        log.warn("a subscription's endpoint is not a supported push service; nothing was sent to it")
        continue
      }
      const locale: Locale = device.locale === "en" ? "en" : "he"
      const payload = pushPayload(locale, job.kind, event.number, event.fromName)
      const outcome = await this.#send(device, payload)
      if (outcome === "sent") result.sent++
      else if (outcome === "gone") {
        await this.#db
          .delete(pushSubscription)
          .where(and(eq(pushSubscription.id, device.id), eq(pushSubscription.endpoint, device.endpoint)))
        result.removed++
      } else result.failed++
    }
    if (result.sent + result.removed + result.failed > 0)
      log.info("browser notifications", { kind: job.kind, ...result })
    return result
  }

  /** One push. Its error, which holds the endpoint and the service's answer, never leaves here. */
  async #send(
    device: { endpoint: string; p256dh: string; auth: string },
    payload: PushPayload,
  ): Promise<"sent" | "gone" | "failed"> {
    try {
      await webpush.sendNotification(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: {
            subject: this.#publicUrl.origin,
            publicKey: this.#vapid.publicKey,
            privateKey: this.#vapid.privateKey,
          },
          TTL: PUSH_TTL_SECONDS,
          urgency: "high",
          timeout: PUSH_TIMEOUT_MS,
          ...(this.#agent ? { agent: this.#agent } : {}),
        },
      )
      return "sent"
    } catch (error) {
      const status = error instanceof webpush.WebPushError ? error.statusCode : null
      // The browser or the user revoked the subscription: it will never take a push again.
      if (status === 404 || status === 410) return "gone"
      log.warn("a browser notification was not delivered to its push service", {
        status,
        ...(status === null ? errorFacts(error) : {}),
      })
      return "failed"
    }
  }
}

/** The job's handler: its data checked, then the notification. */
export async function pushNotifyJob(notifier: PushNotifier, data: unknown): Promise<PushResult | null> {
  const job = data as Partial<PushJob> | null
  const kinds: unknown[] = ["new_ticket", "customer_reply"]
  if (!job || typeof job.ticketId !== "string" || typeof job.messageId !== "string" || !kinds.includes(job.kind))
    return null
  return notifier.notify(job as PushJob)
}
