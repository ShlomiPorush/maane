import { createHash, timingSafeEqual } from "node:crypto"
import { type Context, Hono, type Next } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { Db } from "../db/client.ts"
import { applyWebhookEvent, webhookEvents } from "../delivery/service.ts"
import { log } from "../log.ts"
import type { Settings } from "../settings/service.ts"

const BODY_MAX = 64 * 1024

function same(given: string, secret: string): boolean {
  if (secret === "") return false
  const digest = (text: string) => createHash("sha256").update(text, "utf8").digest()
  return timingSafeEqual(digest(given), digest(secret)) && given.length === secret.length
}

async function payloadOf(c: Context): Promise<unknown> {
  const type = (c.req.header("content-type") ?? "").toLowerCase()
  try {
    if (type.startsWith("application/json")) return await c.req.json()
    if (type.startsWith("application/x-www-form-urlencoded") || type.startsWith("multipart/form-data"))
      return await c.req.parseBody()
  } catch {}
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
