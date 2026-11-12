import type { Actor } from "../audit.ts"

/** The signed-in user of a request to /api/v1, as the session middleware in app.ts sets it. */
export type AppUser = { id: string; username: string; role: string }
export type ApiEnv = { Variables: { user: AppUser; actor: Actor } }

/** The client address as the proxy reported it: the last X-Forwarded-For hop (Traefik replaces client headers). */
export function clientIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || null
}
