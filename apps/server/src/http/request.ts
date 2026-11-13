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

/** The client address as the proxy reported it: the last X-Forwarded-For hop (Traefik replaces client headers). */
export function clientIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || null
}
