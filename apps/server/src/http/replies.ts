// Replies, internal notes, and the composer's uploads (plan 3.1), mounted under /api/v1 behind its session, two-factor,
// CSRF, and Origin checks. Every route reads the user's scope (visibleOrganizations) on each request; a ticket or a
// message outside it answers 404 as if it did not exist. An upload belongs to its uploader alone.

import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { Db } from "../db/client.ts"
import { Refusal } from "../organizations/refusal.ts"
import { visibleOrganizations } from "../organizations/scope.ts"
import { type Replies, ReplyBody, type ReplyUser } from "../replies/service.ts"
import type { Settings } from "../settings/service.ts"
import { type ApiEnv, clientIp } from "./request.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NUMBER = /^[1-9][0-9]{0,15}$/
/** Room for the multipart framing around a file of files.maxBytes. */
const MULTIPART_OVERHEAD = 64 * 1024

type Handler = (c: Context<ApiEnv>) => Promise<Response>

/** Runs a handler and answers a refusal with its code; anything else goes to the app's error handler. */
const refusals =
  (handler: Handler): Handler =>
  async (c) => {
    try {
      return await handler(c)
    } catch (error) {
      if (error instanceof Refusal) return c.json({ error: error.code, ...error.details }, error.status)
      throw error
    }
  }

export function replyRoutes(db: Db, settings: Settings, replies: Replies): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>()
  const scopeOf = (c: Context<ApiEnv>) => visibleOrganizations(db, c.get("user"))
  const userOf = (c: Context<ApiEnv>): ReplyUser => ({
    id: c.get("user").id,
    role: c.get("user").role,
    actor: c.get("actor"),
    ipAddress: clientIp(c.req.raw),
  })
  const messageId = (c: Context<ApiEnv>) => {
    const id = c.req.param("id") ?? ""
    if (!UUID.test(id)) throw new Refusal("not_found", 404)
    return id
  }

  routes.post(
    "/tickets/:number/messages",
    refusals(async (c) => {
      const text = c.req.param("number") ?? ""
      const number = NUMBER.test(text) ? Number(text) : Number.NaN
      if (!Number.isSafeInteger(number)) throw new Refusal("not_found", 404)
      const parsed = ReplyBody.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) throw new Refusal("request_invalid", 400)
      const written = await replies.submit(await scopeOf(c), userOf(c), number, parsed.data)
      return c.json(written, 201)
    }),
  )

  routes.post(
    "/messages/:id/resend",
    refusals(async (c) => {
      await replies.resend(await scopeOf(c), userOf(c), messageId(c))
      return c.json({ ok: true })
    }),
  )

  routes.post(
    "/messages/:id/mark-sent",
    refusals(async (c) => {
      await replies.markSent(await scopeOf(c), userOf(c), messageId(c))
      return c.json({ ok: true })
    }),
  )

  // One file per request, as multipart form data with the field `file`, at most files.maxBytes (Hono's body limit,
  // read for each request, refuses a larger body before it is read whole).
  routes.post("/uploads", async (c, next) => {
    const limit = await settings.get("files.maxBytes")
    return bodyLimit({
      maxSize: limit + MULTIPART_OVERHEAD,
      onError: (c) => c.json({ error: "file_too_large", max: limit }, 413),
    })(c, next)
  })
  routes.post(
    "/uploads",
    refusals(async (c) => {
      const form = await c.req.parseBody().catch(() => null)
      const file = form?.file
      if (!(file instanceof File)) throw new Refusal("request_invalid", 400)
      const view = await replies.upload(userOf(c), {
        name: file.name,
        type: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
      })
      return c.json(view, 202)
    }),
  )

  routes.get(
    "/uploads/:id",
    refusals(async (c) => {
      const view = await replies.uploadView(c.get("user").id, messageId(c))
      if (!view) throw new Refusal("not_found", 404)
      return c.json(view)
    }),
  )

  return routes
}
