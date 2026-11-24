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
import { sendNotification, WebPushError } from "web-push"

export const PUSH_TIMEOUT_MS = 15_000
export const PUSH_TTL_SECONDS = 24 * 60 * 60
export const NAME_MAX = 80

export type PushPayload = { title: string; body: string; number: number }

export interface PushNotifierOptions {
  db: Db
  vapid: VapidKeys
  publicUrl: URL
  endpointAllowed?: (endpoint: string) => boolean
  agent?: Agent
}

export type PushResult = { sent: number; removed: number; failed: number }

const hidden = (code: number) =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x61c ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069)

export function shownName(name: string | null): string {
  if (!name) return ""
  const spaced = name.replace(/[\t\n\v\f\r]/g, " ")
  const visible = [...spaced].filter((char) => !hidden(char.codePointAt(0) ?? 0)).join("")
  if (/\S@\S/.test(visible)) return ""
  return [...visible.replace(/\s+/g, " ").trim()].slice(0, NAME_MAX).join("").trim()
}

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
      const [current] = await this.#db
        .select({ organizationId: ticket.organizationId })
        .from(ticket)
        .where(eq(ticket.id, job.ticketId))
      if (!current) break
      const scope = await visibleOrganizations(this.#db, { id: user.id, role: user.role ?? "agent" })
      if (!inScope(scope, current.organizationId)) continue
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

  async #send(
    device: { endpoint: string; p256dh: string; auth: string },
    payload: PushPayload,
  ): Promise<"sent" | "gone" | "failed"> {
    try {
      await sendNotification(
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
      const status = error instanceof WebPushError ? error.statusCode : null
      if (status === 404 || status === 410) return "gone"
      log.warn("a browser notification was not delivered to its push service", {
        status,
        ...(status === null ? errorFacts(error) : {}),
      })
      return "failed"
    }
  }
}

export async function pushNotifyJob(notifier: PushNotifier, data: unknown): Promise<PushResult | null> {
  const job = data as Partial<PushJob> | null
  const kinds: unknown[] = ["new_ticket", "customer_reply"]
  if (!job || typeof job.ticketId !== "string" || typeof job.messageId !== "string" || !kinds.includes(job.kind))
    return null
  return notifier.notify(job as PushJob)
}
