import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { HttpBindings } from "@hono/node-server"
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
import { Imports } from "../imports/service.ts"
import { GRAPH_TEST, type JobQueue, SCANNER_SELF_TEST, SMTP_TEST } from "../jobs/queue.ts"
import { Geo } from "../links/geo.ts"
import { Links } from "../links/service.ts"
import { errorFacts, log, loggedPath } from "../log.ts"
import { Subscriptions } from "../notifications/service.ts"
import { Refusal } from "../organizations/refusal.ts"
import { Organizations } from "../organizations/service.ts"
import { Replies } from "../replies/service.ts"
import { type Settings, SettingsError } from "../settings/service.ts"
import { clientIp, rememberClient, trustOf } from "./client.ts"
import { hookRoutes } from "./hooks.ts"
import { importRoutes } from "./imports.ts"
import { linkRoutes } from "./links.ts"
import { notificationRoutes } from "./notifications.ts"
import { organizationRoutes } from "./organizations.ts"
import { replyRoutes } from "./replies.ts"
import { type ApiEnv, adminOnly } from "./request.ts"
import { ticketRoutes } from "./tickets.ts"
import { workflowRoutes } from "./workflow.ts"

export interface AppContext {
  db: Db
  auth: () => Auth
  settings: Settings
  setup: SetupWindow
  publicUrl: URL
  webDir: string
  filesDir: string
  version: string
  onSettingsChanged?: () => Promise<void>
  jobs: JobQueue
  trustedProxies: string[]
  geoipDir: string | null
  vapidPublicKey: string
  archiveDir: string
}

type Env = ApiEnv

const selfTestOutput = z.object({
  address: z.string(),
  ok: z.boolean(),
  failedCheck: z.enum(SCANNER_CHECKS).nullable(),
  version: z.string().nullable(),
  checkedAt: z.string(),
})

const graphTestOutput = z.object({
  ok: z.boolean(),
  problem: z.enum(GRAPH_PROBLEMS).nullable(),
  code: z.string().nullable(),
  status: z.number().int().nullable(),
  mailbox: z.string(),
  checkedAt: z.string(),
})

const smtpTestOutput = z.object({
  provider: z.enum(PROVIDERS),
  ok: z.boolean(),
  problem: z.enum(SMTP_PROBLEMS).nullable(),
  code: z.string().nullable(),
  response: z.string().nullable(),
  checkedAt: z.string(),
})

const hiddenPoint = (code: number) =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x61c ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069)
const HIDDEN = { test: (text: string) => [...text].some((char) => hiddenPoint(char.codePointAt(0) ?? 0)) }

const AgentName = z.object({
  name: z
    .string()
    .transform((text) => text.trim())
    .refine((text) => {
      const length = [...text].length
      return length >= 1 && length <= AGENT_NAME_MAX && !HIDDEN.test(text) && text.isWellFormed()
    }),
})

const TEST_STATES: Record<string, ScannerTestView["state"]> = {
  created: "queued",
  retry: "queued",
  active: "running",
  completed: "done",
  cancelled: "failed",
  failed: "failed",
}

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const REQUEST_HEADER = "x-maane-request"

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
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ")

export function createApp(ctx: AppContext) {
  const app = new Hono<Env>()

  const trust = trustOf(ctx.trustedProxies)
  app.use("*", async (c, next) => {
    rememberClient(c.req.raw, (c.env as Partial<HttpBindings> | undefined)?.incoming, trust)
    await next()
  })

  app.use("*", async (c, next) => {
    await next()
    const own = c.get("security")
    c.header("Content-Security-Policy", own?.csp ?? CSP)
    c.header("X-Content-Type-Options", "nosniff")
    c.header("Referrer-Policy", "no-referrer")
    if (!own || own.frameDeny) c.header("X-Frame-Options", "DENY")
    if (c.req.path === "/api/v1" || c.req.path.startsWith("/api/v1/")) c.header("Cache-Control", "private, no-store")
    else if (c.res.headers.get("content-type")?.startsWith("text/html")) c.header("Cache-Control", "no-store")
  })

  app.get("/healthz/live", (c) => c.json({ ok: true, version: ctx.version }))
  app.get("/healthz/ready", async (c) => {
    try {
      await ctx.db.select({ n: sql<number>`1` }).from(authUser).limit(1)
      return c.json({ ok: true, database: "ok", version: ctx.version })
    } catch (error) {
      log.warn("readiness check failed", errorFacts(error))
      return c.json({ ok: false, database: "unavailable" }, 503)
    }
  })

  const links = new Links(ctx.db, ctx.settings, new Geo(ctx.geoipDir))
  app.route("/", linkRoutes(links, ctx.settings, ctx.filesDir))

  app.on(["GET", "POST"], "/api/auth/*", (c) => ctx.auth().handler(c.req.raw))

  app.get("/api/setup/status", async (c) => {
    const [row] = await ctx.db.select({ id: authUser.id }).from(authUser).limit(1)
    const hasUser = row !== undefined
    const open = !hasUser && ctx.setup.isOpen()
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

  api.use("/admin/*", adminOnly)

  api.get("/me", (c) => c.json(c.get("user")))

  api.get("/settings", adminOnly, async (c) => c.json({ settings: await ctx.settings.view() }))

  api.put("/settings", adminOnly, async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = z.record(z.string(), z.unknown()).safeParse(body)
    if (!parsed.success) return c.json({ error: "setting_invalid" }, 400)
    try {
      await ctx.settings.update(parsed.data, c.get("actor"), clientIp(c.req.raw))
    } catch (error) {
      if (error instanceof SettingsError) {
        return c.json({ error: error.code, key: error.key }, error.code === "setting_locked" ? 409 : 400)
      }
      throw error
    }
    await ctx.onSettingsChanged?.()
    if ("scanner.address" in parsed.data) {
      await ctx.jobs
        .send(SCANNER_SELF_TEST)
        .catch((error) => log.warn("could not queue the scanner self-test", errorFacts(error)))
    }
    return c.json({ settings: await ctx.settings.view() })
  })

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

  api.put("/admin/users/:id/name", async (c) => {
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
  api.route("/admin/import", importRoutes(new Imports(ctx.db, ctx.jobs, ctx.archiveDir)))
  api.route("/notifications", notificationRoutes(new Subscriptions(ctx.db), ctx.vapidPublicKey))
  const replies = new Replies(ctx.db, ctx.settings, ctx.jobs, ctx.filesDir, ctx.publicUrl)
  api.route("/", ticketRoutes(ctx.db, ctx.filesDir, replies))
  api.route("/", replyRoutes(ctx.db, ctx.settings, replies))
  api.route("/", workflowRoutes(ctx.db, ctx.jobs))

  app.route("/api/v1", api)
  app.route("/hooks", hookRoutes(ctx.db, ctx.settings))
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404))

  app.get("*", serveStatic({ root: ctx.webDir }))
  app.get("*", async (c) => {
    const html = await readFile(join(ctx.webDir, "index.html"), "utf8").catch(() => null)
    if (html === null) return c.text("The web UI is not built.", 503)
    return c.html(html)
  })

  app.onError((error, c) => {
    c.set("security", undefined)
    if (error instanceof Refusal) return c.json({ error: error.code, ...error.details }, error.status)
    log.error("request failed", { path: loggedPath(new URL(c.req.url).pathname), ...errorFacts(error) })
    return c.json({ error: "internal" }, 500)
  })

  return app
}
