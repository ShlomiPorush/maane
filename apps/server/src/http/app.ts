import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { serveStatic } from "@hono/node-server/serve-static"
import { desc, lt, sql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { Auth } from "../auth/auth.ts"
import type { SetupWindow } from "../auth/setup-window.ts"
import type { Db } from "../db/client.ts"
import { auditLog, authUser } from "../db/schema.ts"
import { errorFacts, log } from "../log.ts"
import { Refusal } from "../organizations/refusal.ts"
import { Organizations } from "../organizations/service.ts"
import { type Settings, SettingsError } from "../settings/service.ts"
import { organizationRoutes } from "./organizations.ts"
import { type ApiEnv, type AppUser, clientIp } from "./request.ts"

export interface AppContext {
  db: Db
  /** The running Better Auth instance; rebuilt when a setting it reads changes. */
  auth: () => Auth
  settings: Settings
  setup: SetupWindow
  publicUrl: URL
  webDir: string
  version: string
  /** Called after settings change, so the auth instance can pick up a new session length. */
  onSettingsChanged?: () => Promise<void>
}

type User = AppUser
type Env = ApiEnv

/** The header every state-changing browser request to /api/v1 carries; a cross-site form cannot set it. */
export const REQUEST_HEADER = "x-maane-request"

/** The browser's own headers minus Authorization: Maane's routes read the session from the cookie alone. */
function cookieOnly(headers: Headers): Headers {
  const result = new Headers()
  const cookie = headers.get("cookie")
  if (cookie) result.set("cookie", cookie)
  return result
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ")

export function createApp(ctx: AppContext) {
  const app = new Hono<Env>()

  // On every answer, so no page of the UI is ever served without its Content Security Policy, however it is reached.
  app.use("*", async (c, next) => {
    await next()
    c.header("Content-Security-Policy", CSP)
    c.header("X-Content-Type-Options", "nosniff")
    c.header("Referrer-Policy", "no-referrer")
    c.header("X-Frame-Options", "DENY")
    if (c.res.headers.get("content-type")?.startsWith("text/html")) c.header("Cache-Control", "no-store")
  })

  app.get("/healthz/live", (c) => c.json({ ok: true, version: ctx.version }))
  app.get("/healthz/ready", async (c) => {
    try {
      // Reads a table the migrations create: the database answers and is migrated.
      await ctx.db.select({ n: sql<number>`1` }).from(authUser).limit(1)
      return c.json({ ok: true, database: "ok", version: ctx.version })
    } catch (error) {
      log.warn("readiness check failed", errorFacts(error))
      return c.json({ ok: false, database: "unavailable" }, 503)
    }
  })

  app.on(["GET", "POST"], "/api/auth/*", (c) => ctx.auth().handler(c.req.raw))

  app.get("/api/setup/status", async (c) => {
    const [row] = await ctx.db.select({ id: authUser.id }).from(authUser).limit(1)
    const hasUser = row !== undefined
    const open = !hasUser && ctx.setup.isOpen()
    // The language the UI starts in before anyone signs in, unless the browser chose one itself.
    const defaultLocale = await ctx.settings.get("general.defaultLocale")
    return c.json({
      hasUser,
      open,
      closesInSeconds: open ? Math.ceil(ctx.setup.remainingMs() / 1000) : 0,
      defaultLocale,
    })
  })

  const api = new Hono<Env>()
  api.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (c.req.header(REQUEST_HEADER) !== "1" || c.req.header("origin") !== ctx.publicUrl.origin) {
        return c.json({ error: "csrf_refused" }, 403)
      }
    }
    const session = await ctx
      .auth()
      .api.getSession({ headers: cookieOnly(c.req.raw.headers) })
      .catch(() => null)
    if (!session?.user) return c.json({ error: "unauthorized" }, 401)
    if (session.user.twoFactorEnabled !== true) return c.json({ error: "totp_required" }, 403)
    if ((session.user as { banned?: boolean | null }).banned) return c.json({ error: "unauthorized" }, 401)
    const username = String((session.user as { username?: string | null }).username ?? session.user.name)
    const role = String((session.user as { role?: string | null }).role ?? "agent")
    c.set("user", { id: session.user.id, username, role })
    c.set("actor", { userId: session.user.id, label: username })
    await next()
  })

  const adminOnly = async (
    c: { get: (k: "user") => User; json: (b: unknown, s: 403) => Response },
    next: () => Promise<void>,
  ) => {
    if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403)
    await next()
  }

  api.get("/me", (c) => c.json(c.get("user")))

  api.get("/settings", adminOnly, async (c) => c.json({ settings: await ctx.settings.view() }))

  api.put("/settings", adminOnly, async (c) => {
    const body = await c.req.json().catch(() => null)
    // Any keys: the settings service refuses an unknown one with setting_unknown before writing anything.
    const parsed = z.record(z.string(), z.unknown()).safeParse(body)
    if (!parsed.success) return c.json({ error: "setting_invalid" }, 400)
    try {
      await ctx.settings.update(parsed.data, c.get("actor"), clientIp(c.req.raw))
    } catch (error) {
      if (error instanceof SettingsError) {
        return c.json({ error: error.code, key: error.key }, error.code === "setting_locked" ? 409 : 400)
      }
      // The intake mode's rule (live needs a default address): its code and the key it refuses.
      if (error instanceof Refusal) return c.json({ error: error.code, ...error.details }, error.status)
      throw error
    }
    await ctx.onSettingsChanged?.()
    return c.json({ settings: await ctx.settings.view() })
  })

  api.get("/audit", adminOnly, async (c) => {
    const before = Number(c.req.query("before") ?? 0)
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200)
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(before > 0 ? lt(auditLog.id, before) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(limit)
    return c.json({ entries: rows, next: rows.length === limit ? rows.at(-1)?.id : null })
  })

  api.route("/admin/organizations", organizationRoutes(new Organizations(ctx.db)))

  app.route("/api/v1", api)
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404))

  // The built UI: files as they are, every other path gets index.html (client-side routes).
  app.get("*", serveStatic({ root: ctx.webDir }))
  app.get("*", async (c) => {
    const html = await readFile(join(ctx.webDir, "index.html"), "utf8").catch(() => null)
    if (html === null) return c.text("The web UI is not built.", 503)
    return c.html(html)
  })

  app.onError((error, c) => {
    log.error("request failed", { path: new URL(c.req.url).pathname, ...errorFacts(error) })
    return c.json({ error: "internal" }, 500)
  })

  return app
}
