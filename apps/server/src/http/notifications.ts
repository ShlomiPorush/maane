import { LOCALES } from "@maane/shared"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { ENDPOINT_MAX } from "../notifications/push.ts"
import type { Subscriptions } from "../notifications/service.ts"
import { Refusal } from "../organizations/refusal.ts"
import type { ApiEnv } from "./request.ts"

const Endpoint = z.string().min(1).max(ENDPOINT_MAX)
const KEY_MAX = 200
const StateBody = z.object({ endpoint: Endpoint.nullable(), locale: z.enum(LOCALES).optional() })
const SubscribeBody = z.object({
  endpoint: Endpoint,
  keys: z.object({ p256dh: z.string().min(1).max(KEY_MAX), auth: z.string().min(1).max(KEY_MAX) }),
  locale: z.enum(LOCALES),
})
const UnsubscribeBody = z.object({ endpoint: Endpoint })

async function body<T>(c: Context<ApiEnv>, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw new Refusal("push_subscription_invalid", 400)
  return parsed.data
}

export function notificationRoutes(subscriptions: Subscriptions, vapidPublicKey: string): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>()

  routes.post("/state", async (c) => {
    const { endpoint, locale } = await body(c, StateBody)
    const userId = c.get("user").id
    const on =
      endpoint !== null &&
      (locale ? await subscriptions.setLocale(userId, endpoint, locale) : await subscriptions.isOn(userId, endpoint))
    return c.json({ publicKey: vapidPublicKey, on })
  })

  routes.put("/subscription", async (c) => {
    await subscriptions.subscribe(c.get("user").id, await body(c, SubscribeBody))
    return c.json({ on: true })
  })

  routes.delete("/subscription", async (c) => {
    const { endpoint } = await body(c, UnsubscribeBody)
    await subscriptions.unsubscribe(c.get("user").id, endpoint)
    return c.json({ on: false })
  })

  return routes
}
