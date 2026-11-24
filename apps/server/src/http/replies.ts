import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import type { Db } from "../db/client.ts"
import { Refusal } from "../organizations/refusal.ts"
import { visibleOrganizations } from "../organizations/scope.ts"
import { type Replies, ReplyBody, type ReplyUser, ScheduledBody } from "../replies/service.ts"
import type { Settings } from "../settings/service.ts"
import { type ApiEnv, clientIp } from "./request.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NUMBER = /^[1-9][0-9]{0,15}$/
const MULTIPART_OVERHEAD = 64 * 1024
const MarkSentBody = z.object({ address: z.string().min(1).max(254) })

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

  routes.post("/tickets/:number/messages", async (c) => {
    const text = c.req.param("number") ?? ""
    const number = NUMBER.test(text) ? Number(text) : Number.NaN
    if (!Number.isSafeInteger(number)) throw new Refusal("not_found", 404)
    const parsed = ReplyBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new Refusal("request_invalid", 400)
    const written = await replies.submit(await scopeOf(c), userOf(c), number, parsed.data)
    return c.json(written, 201)
  })

  routes.put("/scheduled/:id", async (c) => {
    const parsed = ScheduledBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new Refusal("request_invalid", 400)
    await replies.changeScheduled(await scopeOf(c), userOf(c), messageId(c), parsed.data)
    return c.json({ ok: true })
  })

  routes.post("/scheduled/:id/cancel", async (c) => {
    await replies.cancelScheduled(await scopeOf(c), userOf(c), messageId(c))
    return c.json({ ok: true })
  })

  routes.post("/messages/:id/resend", async (c) => {
    await replies.resend(await scopeOf(c), userOf(c), messageId(c))
    return c.json({ ok: true })
  })

  routes.post("/messages/:id/mark-sent", async (c) => {
    const parsed = MarkSentBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new Refusal("request_invalid", 400)
    await replies.markSent(await scopeOf(c), userOf(c), messageId(c), parsed.data.address)
    return c.json({ ok: true })
  })

  routes.post("/uploads", async (c, next) => {
    const limit = await settings.get("files.maxBytes")
    return bodyLimit({
      maxSize: limit + MULTIPART_OVERHEAD,
      onError: (c) => c.json({ error: "file_too_large", max: limit }, 413),
    })(c, next)
  })
  routes.post("/uploads", async (c) => {
    const form = await c.req.parseBody().catch(() => null)
    const file = form?.file
    if (!(file instanceof File)) throw new Refusal("request_invalid", 400)
    const view = await replies.upload(userOf(c), {
      name: file.name,
      type: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    })
    return c.json(view, 202)
  })

  routes.get("/uploads/:id", async (c) => {
    const view = await replies.uploadView(c.get("user").id, messageId(c))
    if (!view) throw new Refusal("not_found", 404)
    return c.json(view)
  })

  return routes
}
