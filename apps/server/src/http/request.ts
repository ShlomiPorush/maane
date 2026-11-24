import { createMiddleware } from "hono/factory"
import type { Actor } from "../audit.ts"
import type { SecurityHeaders } from "./tickets.ts"

/** The signed-in user of a request to /api/v1, as the session middleware in app.ts sets it. */
export type AppUser = { id: string; username: string; role: string }
export type ApiEnv = {
  Variables: {
    user: AppUser
    actor: Actor
    /** Security headers the route declares for its successful answer, in place of the UI's (app.ts). */
    security?: SecurityHeaders
  }
}

/** Refuses everyone but an admin; runs after the session middleware of /api/v1, which sets the user. */
export const adminOnly = createMiddleware<ApiEnv>(async (c, next) => {
  if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403)
  await next()
})

/** The client address of a request: the TCP peer, or X-Forwarded-For only behind the trusted proxies (client.ts). */
export { clientIp } from "./client.ts"
