import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { serveStatic } from "@hono/node-server/serve-static"
import {
  AGENT_NAME_MAX,
  GRAPH_PROBLEMS,
  type GraphTestView,
  PROVIDERS,
  SCANNER_CHECKS,
  type ScannerStatusView,
  type ScannerTestView,
  SMTP_PROBLEMS,
  type SmtpTestView,
  type WebhookSecretsView,
} from "@maane/shared"
import { APIError } from "better-auth/api"
import { desc, eq, lt, sql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { writeAudit } from "../audit.ts"
import type { Auth } from "../auth/auth.ts"
import type { SetupWindow } from "../auth/setup-window.ts"
import type { Db } from "../db/client.ts"
import { auditLog, authUser, scannerCheck } from "../db/schema.ts"
import { GRAPH_TEST, type JobQueue, SCANNER_SELF_TEST, SMTP_TEST } from "../jobs/queue.ts"
import { trustOf } from "../links/client.ts"
import { Geo } from "../links/geo.ts"
import { Links } from "../links/service.ts"
import { errorFacts, log, loggedPath } from "../log.ts"
import { Refusal } from "../organizations/refusal.ts"
import { Organizations } from "../organizations/service.ts"
import { Replies } from "../replies/service.ts"
import { type Settings, SettingsError } from "../settings/service.ts"
import { hookRoutes } from "./hooks.ts"
import { linkRoutes } from "./links.ts"
import { organizationRoutes } from "./organizations.ts"
import { replyRoutes } from "./replies.ts"
import { type ApiEnv, type AppUser, clientIp } from "./request.ts"
import { ticketRoutes } from "./tickets.ts"

export interface AppContext {
  db: Db
  /** The running Better Auth instance; rebuilt when a setting it reads changes. */
  auth: () => Auth
  settings: Settings
  setup: SetupWindow
  publicUrl: URL
  webDir: string
  /** The content-addressed file store the worker writes (MAANE_FILES_DIR); the server only reads it. */
  filesDir: string
  version: string
  /** Called after settings change, so the auth instance can pick up a new session length. */
  onSettingsChanged?: () => Promise<void>
  /** The job queue: the server only queues jobs the worker runs, and reads their state. */
  jobs: JobQueue
  /** MAANE_TRUSTED_PROXIES: only a request from one of these may name its client in X-Forwarded-For (the link routes). */
  trustedProxies: string[]
  /** MAANE_GEOIP_DIR: the read-only directory of the GeoLite2 City and ASN files, or null for no location. */
  geoipDir: string | null
}

type User = AppUser
type Env = ApiEnv

/** The output the worker's self-test job returns, read back with its shape checked. */
const selfTestOutput = z.object({
  address: z.string(),
  ok: z.boolean(),
  failedCheck: z.enum(SCANNER_CHECKS).nullable(),
  version: z.string().nullable(),
  checkedAt: z.string(),
})

/** The output the worker's Graph connection test returns, read back with its shape checked. */
const graphTestOutput = z.object({
  ok: z.boolean(),
  problem: z.enum(GRAPH_PROBLEMS).nullable(),
  code: z.string().nullable(),
  status: z.number().int().nullable(),
  mailbox: z.string(),
  checkedAt: z.string(),
})

/** The output the worker's SMTP connection test returns, read back with its shape checked. */
const smtpTestOutput = z.object({
  provider: z.enum(PROVIDERS),
  ok: z.boolean(),
  problem: z.enum(SMTP_PROBLEMS).nullable(),
  code: z.string().nullable(),
  response: z.string().nullable(),
  checkedAt: z.string(),
})

/** Control characters and the characters that reorder text: a display name shows in the From line of every reply. */
const hiddenPoint = (code: number) =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x61c ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069)
const HIDDEN = { test: (text: string) => [...text].some((char) => hiddenPoint(char.codePointAt(0) ?? 0)) }

/** An agent's display name (plan 3.1): trimmed, 1 to AGENT_NAME_MAX characters, nothing hidden. */
const AgentName = z.object({
  name: z
    .string()
    .transform((text) => text.trim())
    .refine((text) => {
      const length = [...text].length
      return length >= 1 && length <= AGENT_NAME_MAX && !HIDDEN.test(text) && text.isWellFormed()
    }),
})

/** pg-boss's job states, as the Settings page shows a connection test. */
const TEST_STATES: Record<string, ScannerTestView["state"]> = {
  created: "queued",
  retry: "queued",
  active: "running",
  completed: "done",
  cancelled: "failed",
  failed: "failed",
}

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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
  // The ticket view frames each message body from /api/v1/messages/:id/body, which sends its own policy.
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ")

export function createApp(ctx: AppContext) {
  const app = new Hono<Env>()

  // On every answer, so no page of the UI is ever served without its Content Security Policy, however it is reached. A
  // route may declare its own policy for its successful answer (a message body, a file: SecurityHeaders in
  // tickets.ts); every other answer, a refusal or an error of that route included, gets the UI's.
  app.use("*", async (c, next) => {
    await next()
    const own = c.get("security")
    c.header("Content-Security-Policy", own?.csp ?? CSP)
    c.header("X-Content-Type-Options", "nosniff")
    c.header("Referrer-Policy", "no-referrer")
    if (!own || own.frameDeny) c.header("X-Frame-Options", "DENY")
    // Everything under /api/v1 is private to the signed-in user and checked on every request (scope, role): no browser
    // or proxy may keep a copy, success or refusal, so nothing is ever served again without that check.
    if (c.req.path === "/api/v1" || c.req.path.startsWith("/api/v1/")) c.header("Cache-Control", "private, no-store")
    else if (c.res.headers.get("content-type")?.startsWith("text/html")) c.header("Cache-Control", "no-store")
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

  // Tracked links and download links (plan 3.4): public, before the UI's fallback.
  const links = new Links(ctx.db, ctx.settings, new Geo(ctx.geoipDir))
  app.route("/", linkRoutes(links, ctx.settings, ctx.filesDir, trustOf(ctx.trustedProxies)))

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
    // A new scanner address is trusted only after it passed the self-test: the worker runs it now.
    if ("scanner.address" in parsed.data) {
      await ctx.jobs
        .send(SCANNER_SELF_TEST)
        .catch((error) => log.warn("could not queue the scanner self-test", errorFacts(error)))
    }
    return c.json({ settings: await ctx.settings.view() })
  })

  // The scanner's latest self-test, and a connection test the worker runs (the server never calls the scanner).
  api.get("/settings/scanner", adminOnly, async (c) => {
    const [row] = await ctx.db.select().from(scannerCheck).where(eq(scannerCheck.id, 1))
    const status: ScannerStatusView | null = row
      ? {
          address: row.address,
          ok: row.ok,
          failedCheck: SCANNER_CHECKS.find((check) => check === row.failedCheck) ?? null,
          version: row.version,
          checkedAt: row.checkedAt.toISOString(),
        }
      : null
    return c.json({ status })
  })

  api.post("/settings/scanner/test", adminOnly, async (c) => {
    const id = await ctx.jobs.send(SCANNER_SELF_TEST)
    return c.json({ id }, 202)
  })

  api.get("/settings/scanner/test/:id", adminOnly, async (c) => {
    const id = c.req.param("id")
    const job = JOB_ID.test(id) ? await ctx.jobs.job(SCANNER_SELF_TEST, id) : null
    if (!job) return c.json({ error: "not_found" }, 404)
    const state = TEST_STATES[job.state] ?? "failed"
    const output = state === "done" ? selfTestOutput.safeParse(job.output) : null
    const view: ScannerTestView = {
      state: output && !output.success ? "failed" : state,
      result: output?.success ? output.data : null,
    }
    return c.json(view)
  })

  // The Graph connection test (plan 2.3, P12): the worker reads the intake mailbox's Inbox folder metadata with the
  // saved settings and reports success or Graph's error code. It reads no message and writes nothing.
  api.post("/settings/graph/test", adminOnly, async (c) => {
    const id = await ctx.jobs.send(GRAPH_TEST)
    return c.json({ id }, 202)
  })

  api.get("/settings/graph/test/:id", adminOnly, async (c) => {
    const id = c.req.param("id")
    const job = JOB_ID.test(id) ? await ctx.jobs.job(GRAPH_TEST, id) : null
    if (!job) return c.json({ error: "not_found" }, 404)
    const state = TEST_STATES[job.state] ?? "failed"
    const output = state === "done" ? graphTestOutput.safeParse(job.output) : null
    const view: GraphTestView = {
      state: output && !output.success ? "failed" : state,
      result: output?.success ? output.data : null,
    }
    return c.json(view)
  })

  // The SMTP connection tests (plan 3.1): the worker connects and logs in to one provider with the saved settings
  // (nodemailer's transporter.verify()) and reports success or what failed. It sends nothing.
  api.post("/settings/smtp/:provider/test", adminOnly, async (c) => {
    const provider = c.req.param("provider")
    if (!(PROVIDERS as readonly string[]).includes(provider)) return c.json({ error: "not_found" }, 404)
    const id = await ctx.jobs.send(SMTP_TEST, { provider })
    return c.json({ id }, 202)
  })

  api.get("/settings/smtp/test/:id", adminOnly, async (c) => {
    const id = c.req.param("id")
    const job = JOB_ID.test(id) ? await ctx.jobs.job(SMTP_TEST, id) : null
    if (!job) return c.json({ error: "not_found" }, 404)
    const state = TEST_STATES[job.state] ?? "failed"
    const output = state === "done" ? smtpTestOutput.safeParse(job.output) : null
    const view: SmtpTestView = {
      state: output && !output.success ? "failed" : state,
      result: output?.success ? output.data : null,
    }
    return c.json(view)
  })

  // SMTP2GO's delivery webhook (plan 3.3): a new secret path and Authorization token from the CSPRNG, stored encrypted
  // and shown this once, for the admin to copy into SMTP2GO. Making new ones replaces the old ones at once.
  api.post("/settings/smtp2go/webhook", adminOnly, async (c) => {
    const values = await ctx.settings.generate(
      ["smtp2go.webhookPath", "smtp2go.webhookToken"],
      c.get("actor"),
      clientIp(c.req.raw),
    )
    const view: WebhookSecretsView = {
      url: new URL(`/hooks/smtp2go/${values["smtp2go.webhookPath"]}`, ctx.publicUrl).href,
      token: values["smtp2go.webhookToken"],
    }
    return c.json(view)
  })

  // An agent's display name, which every reply's From line carries (plan 3.1). Better Auth's documented server API
  // updates it, with the admin's own session and the name only; its HTTP route /admin/update-user stays closed.
  api.put("/admin/users/:id/name", adminOnly, async (c) => {
    const userId = c.req.param("id")
    const parsed = AgentName.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success || userId.length === 0 || userId.length > 200) return c.json({ error: "name_invalid" }, 400)
    try {
      await ctx.auth().api.adminUpdateUser({
        body: { userId, data: { name: parsed.data.name } },
        headers: cookieOnly(c.req.raw.headers),
      })
    } catch (error) {
      if (error instanceof APIError) {
        if (error.statusCode === 404) return c.json({ error: "not_found" }, 404)
        if (error.statusCode === 403 || error.statusCode === 401) return c.json({ error: "forbidden" }, 403)
        return c.json({ error: "name_invalid" }, 400)
      }
      throw error
    }
    await writeAudit(ctx.db, c.get("actor"), {
      action: "user.rename",
      entityType: "user",
      entityId: userId,
      details: { name: parsed.data.name },
      ipAddress: clientIp(c.req.raw),
    })
    return c.json({ ok: true })
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
  const replies = new Replies(ctx.db, ctx.settings, ctx.jobs, ctx.filesDir, ctx.publicUrl)
  api.route("/", ticketRoutes(ctx.db, ctx.filesDir, replies))
  api.route("/", replyRoutes(ctx.db, ctx.settings, replies))

  app.route("/api/v1", api)
  app.route("/hooks", hookRoutes(ctx.db, ctx.settings))
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404))

  // The built UI: files as they are, every other path gets index.html (client-side routes).
  app.get("*", serveStatic({ root: ctx.webDir }))
  app.get("*", async (c) => {
    const html = await readFile(join(ctx.webDir, "index.html"), "utf8").catch(() => null)
    if (html === null) return c.text("The web UI is not built.", 503)
    return c.html(html)
  })

  app.onError((error, c) => {
    // An error answer never keeps a policy its route declared for success.
    c.set("security", undefined)
    log.error("request failed", { path: loggedPath(new URL(c.req.url).pathname), ...errorFacts(error) })
    return c.json({ error: "internal" }, 500)
  })

  return app
}
