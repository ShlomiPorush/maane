import { createMiddleware } from "hono/factory"
import type { Actor } from "../audit.ts"
import type { SecurityHeaders } from "./tickets.ts"

export type AppUser = { id: string; username: string; role: string }
export type ApiEnv = {
  Variables: {
    user: AppUser
    actor: Actor
    security?: SecurityHeaders
  }
}

export const adminOnly = createMiddleware<ApiEnv>(async (c, next) => {
  if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403)
  await next()
})

export { clientIp } from "./client.ts"
