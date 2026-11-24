import type { Db } from "@maane/server/db/client"
import { deliveryPoll, outboxRecipient } from "@maane/server/db/schema"
import { ACTIVITY_EVENTS, applyDeliveryEvent, detailOf, eventTime } from "@maane/server/delivery/service"
import { log } from "@maane/server/log"
import type { Settings } from "@maane/server/settings/service"
import { DELIVERY_POLL_MAX_AGE_DAYS, FINAL_DELIVERY_STATUSES } from "@maane/shared"
import { and, eq, gte, isNotNull, isNull, min, notInArray, or } from "drizzle-orm"

export const SMTP2GO_API = "https://api.smtp2go.com/v3"
export const POLL_OVERLAP_MS = 60 * 60_000
export const POLL_PAGE_SIZE = 1000
export const POLL_PAGES_MAX = 20
const DAY_MS = 24 * 60 * 60_000

interface ActivityEvent {
  event: string | null
  emailId: string | null
  recipient: string | null
  date: string | null
  detail: string | null
}

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

export class ActivityError extends Error {
  constructor(readonly status: number) {
    super(`SMTP2GO's activity search answered ${status}`)
    this.name = "ActivityError"
  }
}

export interface ActivityPollOptions {
  db: Db
  settings: Settings
  baseUrl?: string
  now?: () => Date
  timeoutMs?: number
  pageSize?: number
  pagesMax?: number
}

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
        // Keeping the token past a failure would repeat a refused one in every run, and the poll would stay stuck.
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
      await this.#keep(cursor?.until ?? start, token, start, end)
      log.warn("the activity poll stopped at its page limit; the next run goes on from there", { pages })
      return { state: "partial", events, applied }
    }
    await this.#keep(end, null, null, null)
    if (applied > 0) log.info("the activity poll updated delivery statuses", { events, applied })
    return { state: "done", events, applied }
  }

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
