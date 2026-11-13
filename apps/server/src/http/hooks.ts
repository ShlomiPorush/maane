// SMTP2GO's delivery webhook (plan 3.3), at /hooks/smtp2go/<secret path>, outside /api/v1: no session, no CSRF check.
// A request is read only with both secrets, which the admin generates on the Settings page (stored encrypted, shown
// once): the path's secret part and the token of its `Authorization: Bearer` header, each compared in constant time.
//
// - An unknown path (or none generated yet) answers exactly as a path that does not exist, so the path cannot be
//   probed. The right path without the right header answers 401.
// - The path's secret, the header, and the body are never logged, never in an error, never in an audit row: this route
//   logs only counts, and the app's error handler logs no path under /hooks/.
// - It only changes delivery information (delivery/service.ts): it never sends, permits, or blocks a send.
// - An event Maane does not read, or about a reply it does not know, is dropped with a 200, so SMTP2GO does not retry it
//   for two days. An event about a reply that cannot be tied to one recipient's send is recorded on the reply.

import { createHash, timingSafeEqual } from "node:crypto"
import { type Context, Hono, type Next } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { Db } from "../db/client.ts"
import { applyWebhookEvent, webhookEvents } from "../delivery/service.ts"
import { log } from "../log.ts"
import type { Settings } from "../settings/service.ts"

/** SMTP2GO posts one event per request; anything near this is not one of its events. */
const BODY_MAX = 64 * 1024

/** Constant-time equality of two texts (their SHA-256, so the lengths leak nothing either); an empty secret never matches. */
function same(given: string, secret: string): boolean {
  if (secret === "") return false
  const digest = (text: string) => createHash("sha256").update(text, "utf8").digest()
  return timingSafeEqual(digest(given), digest(secret)) && given.length === secret.length
}

/** The body as fields: JSON (an object or an array) or a form, by its content type. Null when it cannot be read. */
async function payloadOf(c: Context): Promise<unknown> {
  const type = (c.req.header("content-type") ?? "").toLowerCase()
  try {
    if (type.startsWith("application/json")) return await c.req.json()
    if (type.startsWith("application/x-www-form-urlencoded") || type.startsWith("multipart/form-data"))
      return await c.req.parseBody()
  } catch {
    // An unreadable body is answered below; its content is never logged.
  }
  return null
}

export function hookRoutes(db: Db, settings: Settings): Hono {
  const routes = new Hono()

  const authenticate = async (c: Context, next: Next) => {
    const path = await settings.get("smtp2go.webhookPath")
    if (!same(c.req.param("secret") ?? "", path)) return c.notFound()
    const token = await settings.get("smtp2go.webhookToken")
    const header = c.req.header("authorization") ?? ""
    const given = /^Bearer (\S+)$/i.exec(header.trim())?.[1] ?? ""
    if (!same(given, token)) {
      log.warn("the SMTP2GO webhook refused a request without its Authorization header")
      return c.json({ error: "unauthorized" }, 401)
    }
    await next()
  }

  routes.post(
    "/smtp2go/:secret",
    authenticate,
    bodyLimit({ maxSize: BODY_MAX, onError: (c) => c.json({ error: "too_large" }, 413) }),
    async (c) => {
      const payload = await payloadOf(c)
      if (payload === null || typeof payload !== "object") return c.json({ error: "invalid" }, 400)
      const events = webhookEvents(payload)
      let applied = 0
      await db.transaction(async (tx) => {
        for (const event of events) if ((await applyWebhookEvent(tx, event)) === "applied") applied++
      })
      log.info("the SMTP2GO webhook read delivery events", { events: events.length, applied })
      return c.json({ ok: true })
    },
  )

  return routes
}
