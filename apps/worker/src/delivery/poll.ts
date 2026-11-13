// The activity poll (plan 3.3), the `delivery-poll` job: a safety net for SMTP2GO webhook events that never arrived.
// It reads SMTP2GO's documented `POST /v3/activity/search` with the API key of the sending settings (3.1), only while a
// recipient SMTP2GO accepted still has no final delivery status, and writes what it finds through the same
// applyDeliveryEvent as the webhook (newer events only; an unknown ID is dropped).
//
// The window: from a little before where the last complete run ended (the durable cursor, `delivery_poll`), so an
// event the provider listed late is read again; never earlier than the oldest such recipient's acceptance, nor than
// DELIVERY_POLL_MAX_AGE_DAYS ago. Every page of a window is read before the cursor moves; a run that fails keeps it.
// A run that reaches its page limit keeps SMTP2GO's documented `continue_token` and its window beside the cursor, and
// the next run goes on from that page with the same window, so no page past the limit is out of reach.
// The API's address is a constant here; only test code gives a stand-in's.

import type { Db } from "@maane/server/db/client"
import { deliveryPoll, outboxRecipient } from "@maane/server/db/schema"
import { ACTIVITY_EVENTS, applyDeliveryEvent, detailOf, eventTime } from "@maane/server/delivery/service"
import { log } from "@maane/server/log"
import type { Settings } from "@maane/server/settings/service"
import { DELIVERY_POLL_MAX_AGE_DAYS, FINAL_DELIVERY_STATUSES } from "@maane/shared"
import { and, eq, gte, isNotNull, isNull, min, notInArray, or } from "drizzle-orm"

/** SMTP2GO's API (its documented base URL). */
export const SMTP2GO_API = "https://api.smtp2go.com/v3"
/** How far before the cursor each window starts again. */
export const POLL_OVERLAP_MS = 60 * 60_000
/** Events per page (the documented maximum), and the most pages one run reads (SMTP2GO allows 60 requests a minute). */
export const POLL_PAGE_SIZE = 1000
export const POLL_PAGES_MAX = 20
const DAY_MS = 24 * 60 * 60_000

/** The fields of an activity event Maane reads; every other field is ignored. */
interface ActivityEvent {
  event: string | null
  emailId: string | null
  recipient: string | null
  date: string | null
  detail: string | null
}

/** A page of the activity search, read field by field: null when its shape is not the documented one. */
export function activityPage(body: unknown): { events: ActivityEvent[]; token: string | null } | null {
  const data = (body as { data?: unknown } | null)?.data
  if (typeof data !== "object" || data === null) return null
  const { events, continue_token: token } = data as { events?: unknown; continue_token?: unknown }
  if (events !== undefined && !Array.isArray(events)) return null
  const text = (value: unknown) => (typeof value === "string" ? value : null)
  return {
    events: (events ?? []).map((item: unknown) => {
      const fields = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {}
      return {
        event: text(fields.event),
        emailId: text(fields.email_id),
        recipient: text(fields.recipient),
        date: text(fields.date),
        detail: text(fields.reason) ?? text(fields.smtp_response),
      }
    }),
    token: typeof token === "string" && token !== "" ? token : null,
  }
}

/** A request the API refused or answered with something else: its status only, never its body. */
export class ActivityError extends Error {
  constructor(readonly status: number) {
    super(`SMTP2GO's activity search answered ${status}`)
    this.name = "ActivityError"
  }
}

export interface ActivityPollOptions {
  db: Db
  settings: Settings
  /** Test code only: a stand-in's address. */
  baseUrl?: string
  now?: () => Date
  timeoutMs?: number
  /** Events per page and pages per run (tests make them small). */
  pageSize?: number
  pagesMax?: number
}

/** ISO 8601 in UTC without fractions, as the activity search's dates. */
const isoSeconds = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z")

export class ActivityPoll {
  readonly #db: Db
  readonly #settings: Settings
  readonly #baseUrl: string
  readonly #now: () => Date
  readonly #timeoutMs: number
  readonly #pageSize: number
  readonly #pagesMax: number

  constructor(options: ActivityPollOptions) {
    this.#db = options.db
    this.#settings = options.settings
    this.#baseUrl = options.baseUrl ?? SMTP2GO_API
    this.#now = options.now ?? (() => new Date())
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#pageSize = options.pageSize ?? POLL_PAGE_SIZE
    this.#pagesMax = options.pagesMax ?? POLL_PAGES_MAX
  }

  async run(): Promise<{
    state: "not_configured" | "nothing_pending" | "done" | "partial"
    events: number
    applied: number
  }> {
    const key = await this.#settings.get("smtp2go.apiKey")
    if (!key) return { state: "not_configured", events: 0, applied: 0 }
    const now = this.#now()
    const floor = new Date(now.getTime() - DELIVERY_POLL_MAX_AGE_DAYS * DAY_MS)
    // Recipients SMTP2GO accepted, with its queue ID, still without a final status, accepted within the age bound.
    const [pending] = await this.#db
      .select({ oldest: min(outboxRecipient.acceptedAt) })
      .from(outboxRecipient)
      .where(
        and(
          eq(outboxRecipient.state, "accepted"),
          eq(outboxRecipient.provider, "smtp2go"),
          isNotNull(outboxRecipient.providerId),
          or(isNull(outboxRecipient.delivery), notInArray(outboxRecipient.delivery, [...FINAL_DELIVERY_STATUSES])),
          gte(outboxRecipient.acceptedAt, floor),
        ),
      )
    if (!pending?.oldest) return { state: "nothing_pending", events: 0, applied: 0 }
    const [cursor] = await this.#db.select().from(deliveryPoll).where(eq(deliveryPoll.id, 1))
    // A window the last run did not finish goes on from its next page; otherwise a new window ends now.
    const resumed = cursor?.continueToken && cursor.windowStart && cursor.windowEnd ? cursor : null
    let start: Date
    let end: Date
    if (resumed?.windowStart && resumed.windowEnd) {
      start = resumed.windowStart
      end = resumed.windowEnd
    } else {
      const starts = [floor.getTime(), pending.oldest.getTime() - POLL_OVERLAP_MS]
      if (cursor) starts.push(cursor.until.getTime() - POLL_OVERLAP_MS)
      start = new Date(Math.min(Math.max(...starts), now.getTime()))
      end = now
    }

    let events = 0
    let applied = 0
    let token: string | null = resumed?.continueToken ?? null
    let pages = 0
    do {
      let page: NonNullable<ReturnType<typeof activityPage>>
      try {
        page = await this.#page(key, start, end, token)
      } catch (error) {
        // A kept token SMTP2GO no longer takes: the next run starts its window again.
        if (resumed && token === resumed.continueToken) await this.#keep(cursor?.until ?? start, null, null, null)
        throw error
      }
      pages++
      events += page.events.length
      await this.#db.transaction(async (tx) => {
        for (const item of page.events) {
          const status =
            item.event && Object.hasOwn(ACTIVITY_EVENTS, item.event) ? ACTIVITY_EVENTS[item.event] : undefined
          const at = eventTime(item.date)
          const providerId = item.emailId?.trim() ?? ""
          const recipient = item.recipient?.trim().toLowerCase() ?? ""
          if (!status || !at || !/^[A-Za-z0-9._-]{1,100}$/.test(providerId) || !recipient) continue
          const detail = status === "delivered" ? null : detailOf(item.detail)
          if (await applyDeliveryEvent(tx, { providerId }, { recipient, status, at, detail, source: "activity" }))
            applied++
        }
      })
      token = page.token
    } while (token && pages < this.#pagesMax)
    if (token) {
      // Not every page of the window was read: the cursor stays, and the next run goes on from this token.
      await this.#keep(cursor?.until ?? start, token, start, end)
      log.warn("the activity poll stopped at its page limit; the next run goes on from there", { pages })
      return { state: "partial", events, applied }
    }
    await this.#keep(end, null, null, null)
    if (applied > 0) log.info("the activity poll updated delivery statuses", { events, applied })
    return { state: "done", events, applied }
  }

  /** The cursor, and the window still being paged through (with its token), or none. */
  async #keep(until: Date, continueToken: string | null, windowStart: Date | null, windowEnd: Date | null) {
    const values = { until, continueToken, windowStart, windowEnd }
    await this.#db
      .insert(deliveryPoll)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: deliveryPoll.id, set: { ...values, updatedAt: new Date() } })
  }

  async #page(key: string, start: Date, end: Date, token: string | null) {
    const response = await fetch(`${this.#baseUrl}/activity/search`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-smtp2go-api-key": key },
      body: JSON.stringify({
        start_date: isoSeconds(start),
        end_date: isoSeconds(end),
        event_types: Object.keys(ACTIVITY_EVENTS),
        limit: this.#pageSize,
        ...(token ? { continue_token: token } : {}),
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
      redirect: "error",
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new ActivityError(response.status)
    }
    const page = activityPage(await response.json().catch(() => null))
    if (!page) throw new ActivityError(response.status)
    return page
  }
}
