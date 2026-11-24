import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { Readable } from "node:stream"
import {
  defaultStatusFilter,
  INTAKE_PAGE_SIZE,
  previewKind,
  SEARCH_MAX_LENGTH,
  STATUS_FILTERS,
  type StatusFilter,
  TICKETS_PAGE_SIZE,
} from "@maane/shared"
import { create as contentDisposition } from "content-disposition"
import { type Context, Hono } from "hono"
import type { Db } from "../db/client.ts"
import { errorFacts, log } from "../log.ts"
import { htmlDocument, textDocument } from "../mail/body.ts"
import { visibleOrganizations } from "../organizations/scope.ts"
import type { Replies } from "../replies/service.ts"
import { wellFormedText } from "../text.ts"
import { CursorError, type FileAccess, Tickets } from "../tickets/service.ts"
import { type ApiEnv, adminOnly } from "./request.ts"

export interface SecurityHeaders {
  csp: string
  frameDeny: boolean
}

export function bodyHeaders(remoteImages: boolean): SecurityHeaders {
  return {
    csp: [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      remoteImages ? "img-src data: https:" : "img-src data:",
      "sandbox allow-popups allow-popups-to-escape-sandbox",
      "frame-ancestors 'self'",
    ].join("; "),
    frameDeny: false,
  }
}

export const FILE_HEADERS: SecurityHeaders = { csp: "default-src 'none'; sandbox", frameDeny: true }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NUMBER = /^[1-9][0-9]{0,15}$/

const notFound = (c: Context<ApiEnv>) => c.json({ error: "not_found" }, 404)
const invalid = (c: Context<ApiEnv>) => c.json({ error: "request_invalid" }, 400)

const BIDI_CONTROLS = new Set([
  0x61c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
])

const unsafe = (point: number) =>
  point < 0x20 || (point >= 0x7f && point <= 0x9f) || BIDI_CONTROLS.has(point) || point === 0x2f || point === 0x5c

export function safeFileName(name: string | null): string {
  const kept = [...(name ?? "").toWellFormed()]
    .map((char) => (unsafe(char.codePointAt(0) ?? 0) ? "_" : char))
    .join("")
    .trim()
  const cleaned = [...kept].slice(0, 200).join("")
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "file" : cleaned
}

export function ticketRoutes(db: Db, filesDir: string, replies: Replies): Hono<ApiEnv> {
  const tickets = new Tickets(db, filesDir)
  const routes = new Hono<ApiEnv>()
  const scopeOf = (c: Context<ApiEnv>) => visibleOrganizations(db, c.get("user"))

  routes.get("/tickets", async (c) => {
    const organization = c.req.query("organization")
    const status = c.req.query("status")
    const category = c.req.query("category")
    const flagged = c.req.query("flagged")
    const search = wellFormedText(c.req.query("q") ?? "").value.trim()
    if (search.length > SEARCH_MAX_LENGTH) return invalid(c)
    if (organization !== undefined && !UUID.test(organization)) return invalid(c)
    if (status !== undefined && !(STATUS_FILTERS as readonly string[]).includes(status)) return invalid(c)
    if (category !== undefined && !UUID.test(category)) return invalid(c)
    if (flagged !== undefined && flagged !== "1") return invalid(c)
    try {
      return c.json(
        await tickets.list(await scopeOf(c), {
          organization,
          search: search || undefined,
          status: (status as StatusFilter | undefined) ?? defaultStatusFilter(search !== ""),
          category,
          flagged: flagged === "1",
          cursor: c.req.query("after"),
          limit: TICKETS_PAGE_SIZE,
        }),
      )
    } catch (error) {
      if (error instanceof CursorError) return invalid(c)
      throw error
    }
  })

  routes.get("/tickets/:number", async (c) => {
    const text = c.req.param("number")
    const number = NUMBER.test(text) ? Number(text) : Number.NaN
    if (!Number.isSafeInteger(number)) return notFound(c)
    const found = await tickets.view(await scopeOf(c), number)
    if (!found) return notFound(c)
    const { ticketId, organizationSignature, ...view } = found
    const compose = await replies.compose(
      c.get("user").id,
      { id: ticketId, organizationId: view.ticket.organization.id, supportAddress: view.ticket.supportAddress },
      view.ticket.organization.name,
      organizationSignature,
    )
    return c.json({ ...view, compose, scheduled: await replies.scheduled(c.get("user").id, ticketId) })
  })

  routes.get("/messages/:id/body", async (c) => {
    const remoteImages = c.req.query("images") === "1"
    const body = await tickets.body(await scopeOf(c), c.req.param("id"), remoteImages)
    if (!body) return notFound(c)
    const document = body.kind === "html" ? htmlDocument(body.html, body.dir) : textDocument(body.text)
    c.set("security", bodyHeaders(remoteImages))
    return c.html(document)
  })

  const serve = async (c: Context<ApiEnv>, access: FileAccess, type: string, disposition: "attachment" | "inline") => {
    if (!access.storedSha256) return notFound(c)
    const path = tickets.storedPath(access.storedSha256)
    const size = await stat(path).then(
      (found) => found.size,
      (error: unknown) => {
        log.warn("a stored file is missing", { sha256: access.storedSha256, ...errorFacts(error) })
        return null
      },
    )
    if (size === null) return notFound(c)
    c.set("security", FILE_HEADERS)
    c.header("Content-Type", type)
    c.header("Content-Length", String(size))
    c.header("Content-Disposition", contentDisposition(safeFileName(access.fileName), { type: disposition }))
    return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream)
  }

  routes.get("/files/:id", async (c) => {
    const access = await tickets.file(await scopeOf(c), c.req.param("id"))
    if (!access?.storedSha256) return notFound(c)
    return serve(c, access, "application/octet-stream", "attachment")
  })

  routes.get("/files/:id/preview", async (c) => {
    const access = await tickets.file(await scopeOf(c), c.req.param("id"))
    if (!access?.storedSha256) return notFound(c)
    const type = access.detectedType
    if (access.storedStatus !== "clean" || type === null || previewKind(access.status, type) === null)
      return c.json({ error: "preview_refused" }, 403)
    return serve(c, access, type === "text/plain" ? "text/plain; charset=utf-8" : type, "inline")
  })

  routes.get("/intake", adminOnly, async (c) => {
    const flagged = c.req.query("flagged")
    if (flagged !== undefined && flagged !== "1") return invalid(c)
    try {
      return c.json(
        await tickets.intake({
          flagged: flagged === "1",
          cursor: c.req.query("after"),
          limit: INTAKE_PAGE_SIZE,
        }),
      )
    } catch (error) {
      if (error instanceof CursorError) return invalid(c)
      throw error
    }
  })

  return routes
}
