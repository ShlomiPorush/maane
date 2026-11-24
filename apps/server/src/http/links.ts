import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { Readable } from "node:stream"
import type { HttpBindings } from "@hono/node-server"
import { MESSAGES } from "@maane/shared"
import { create as contentDisposition } from "content-disposition"
import { type Context, Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { rateLimiter } from "hono-rate-limiter"
import { storedFilePath } from "../files/paths.ts"
import type { Links } from "../links/service.ts"
import { errorFacts, log } from "../log.ts"
import { escapeHtml } from "../replies/layout.ts"
import type { Settings } from "../settings/service.ts"
import { clientIp } from "./client.ts"
import { FILE_HEADERS, type SecurityHeaders, safeFileName } from "./tickets.ts"

export const LINK_RATE_LIMIT = 60
export const LINK_RATE_WINDOW_MS = 60_000

const UNKNOWN_CLIENT = "unknown"

type LinkEnv = { Bindings: Partial<HttpBindings>; Variables: { security?: SecurityHeaders; client: string | null } }

export function linkRoutes(links: Links, settings: Settings, filesDir: string): Hono<LinkEnv> {
  const routes = new Hono<LinkEnv>()

  const page = async (c: Context<LinkEnv>, key: "unknown" | "busy", status: 404 | 429) => {
    const locale = await settings.get("general.defaultLocale")
    const text = escapeHtml(MESSAGES[locale].links[key])
    const dir = locale === "he" ? "rtl" : "ltr"
    return c.html(
      `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><title>Maane</title></head>` +
        `<body><p>${text}</p></body></html>`,
      status,
    )
  }

  const noStore = createMiddleware<LinkEnv>(async (c, next) => {
    c.set("client", clientIp(c.req.raw))
    await next()
    c.header("Cache-Control", "no-store")
  })

  const limit = rateLimiter<LinkEnv>({
    windowMs: LINK_RATE_WINDOW_MS,
    limit: LINK_RATE_LIMIT,
    standardHeaders: "draft-6",
    keyGenerator: (c) => c.get("client") ?? UNKNOWN_CLIENT,
    handler: (c) => page(c, "busy", 429),
  })

  const record = async (c: Context<LinkEnv>, linkId: string) => {
    await links
      .record(linkId, { ip: c.get("client"), userAgent: c.req.header("user-agent") })
      .catch((error) => log.warn("a click could not be recorded", errorFacts(error)))
  }

  routes.get("/l/:code", noStore, limit, async (c) => {
    const found = await links.resolve("url", c.req.param("code"))
    if (found?.kind !== "url") return page(c, "unknown", 404)
    await record(c, found.id)
    return c.redirect(found.url, 302)
  })

  routes.get("/f/:code", noStore, limit, async (c) => {
    const found = await links.resolve("file", c.req.param("code"))
    if (found?.kind !== "file") return page(c, "unknown", 404)
    const path = storedFilePath(filesDir, found.sha256)
    const size = await stat(path).then(
      (file) => file.size,
      (error: unknown) => {
        log.warn("a stored file is missing", { sha256: found.sha256, ...errorFacts(error) })
        return null
      },
    )
    if (size === null) return page(c, "unknown", 404)
    await record(c, found.id)
    c.set("security", FILE_HEADERS)
    c.header("Content-Type", "application/octet-stream")
    c.header("Content-Length", String(size))
    c.header("Content-Disposition", contentDisposition(safeFileName(found.fileName), { type: "attachment" }))
    return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream)
  })

  routes.get("/l/*", noStore, limit, (c) => page(c, "unknown", 404))
  routes.get("/f/*", noStore, limit, (c) => page(c, "unknown", 404))

  return routes
}
