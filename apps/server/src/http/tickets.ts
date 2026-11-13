// The ticket list and view, message bodies, files, and the intake log (plan 2.4), mounted under /api/v1 behind its
// session and two-factor checks. Every route reads the user's scope (visibleOrganizations) on each request, so a member
// removed from an organization is refused at once, and a ticket, message, or file outside it answers 404 as if it did
// not exist. The body route and the file routes declare their own security headers (see SecurityHeaders in app.ts).

import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { Readable } from "node:stream"
import { INTAKE_FILTER_MODES, INTAKE_PAGE_SIZE, previewKind, TICKET_STATUSES, TICKETS_PAGE_SIZE } from "@maane/shared"
import { create as contentDisposition } from "content-disposition"
import { type Context, Hono } from "hono"
import type { Db } from "../db/client.ts"
import { errorFacts, log } from "../log.ts"
import { htmlDocument, textDocument } from "../mail/body.ts"
import { visibleOrganizations } from "../organizations/scope.ts"
import { CursorError, type FileAccess, Tickets } from "../tickets/service.ts"
import type { ApiEnv } from "./request.ts"

/**
 * Security headers a route declares for its successful answer, in place of the UI's (app.ts). A refusal or an error of
 * the same route keeps the UI's, X-Frame-Options included.
 */
export interface SecurityHeaders {
  csp: string
  /** X-Frame-Options: DENY; the body route leaves it out so the ticket view may frame it (frame-ancestors 'self'). */
  frameDeny: boolean
}

/** A message body in the ticket view's frame: inline styles, its own data: images, https images once allowed. */
export function bodyHeaders(remoteImages: boolean): SecurityHeaders {
  return {
    csp: [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      remoteImages ? "img-src data: https:" : "img-src data:",
      // Links open in a new tab that leaves the sandbox (owner's decision, 2026-11-13); nothing in the frame runs.
      "sandbox allow-popups allow-popups-to-escape-sandbox",
      "frame-ancestors 'self'",
    ].join("; "),
    frameDeny: false,
  }
}

/** A file served as itself (a download, a preview): nothing in it may run or load anything. */
export const FILE_HEADERS: SecurityHeaders = { csp: "default-src 'none'; sandbox", frameDeny: true }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NUMBER = /^[1-9][0-9]{0,15}$/

const notFound = (c: Context<ApiEnv>) => c.json({ error: "not_found" }, 404)
const invalid = (c: Context<ApiEnv>) => c.json({ error: "request_invalid" }, 400)

/**
 * A file name safe for a header: control characters (CR and LF among them), bidirectional controls, and path
 * separators become "_"; content-disposition then writes the RFC 6266 header (an ASCII fallback, and the UTF-8 name as
 * filename*).
 */
/** Bidirectional controls: ALM, LRM, RLM, the embeddings and overrides, and the isolates. */
const BIDI_CONTROLS = new Set([
  0x61c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
])

/** A character a file name in a header may not keep: a C0 or C1 control, DEL, a bidirectional control, a separator. */
const unsafe = (point: number) =>
  point < 0x20 || (point >= 0x7f && point <= 0x9f) || BIDI_CONTROLS.has(point) || point === 0x2f || point === 0x5c

export function safeFileName(name: string | null): string {
  // Well formed first (an unpaired surrogate becomes U+FFFD), so the UTF-8 form of the name always exists.
  const kept = [...(name ?? "").toWellFormed()]
    .map((char) => (unsafe(char.codePointAt(0) ?? 0) ? "_" : char))
    .join("")
    .trim()
  // At most 200 characters, cut between code points: half of a surrogate pair would make the header unwritable.
  const cleaned = [...kept].slice(0, 200).join("")
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "file" : cleaned
}

export function ticketRoutes(db: Db, filesDir: string): Hono<ApiEnv> {
  const tickets = new Tickets(db, filesDir)
  const routes = new Hono<ApiEnv>()
  const scopeOf = (c: Context<ApiEnv>) => visibleOrganizations(db, c.get("user"))

  routes.get("/tickets", async (c) => {
    const organization = c.req.query("organization")
    const status = c.req.query("status")
    const flagged = c.req.query("flagged")
    if (organization !== undefined && !UUID.test(organization)) return invalid(c)
    if (status !== undefined && !(TICKET_STATUSES as readonly string[]).includes(status)) return invalid(c)
    if (flagged !== undefined && flagged !== "1") return invalid(c)
    try {
      return c.json(
        await tickets.list(await scopeOf(c), {
          organization,
          status: status as (typeof TICKET_STATUSES)[number] | undefined,
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
    const view = await tickets.view(await scopeOf(c), number)
    return view ? c.json(view) : notFound(c)
  })

  routes.get("/messages/:id/body", async (c) => {
    const remoteImages = c.req.query("images") === "1"
    const body = await tickets.body(await scopeOf(c), c.req.param("id"), remoteImages)
    if (!body) return notFound(c)
    const document = body.kind === "html" ? htmlDocument(body.html, body.text) : textDocument(body.text)
    c.set("security", bodyHeaders(remoteImages))
    return c.html(document)
  })

  /** The stored file of a part the user may reach, as a stream, or a 404. */
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

  // A download: every stored file (clean, not fully scanned, or not scanned) as bytes, never as its own type.
  routes.get("/files/:id", async (c) => {
    const access = await tickets.file(await scopeOf(c), c.req.param("id"))
    if (!access?.storedSha256) return notFound(c)
    return serve(c, access, "application/octet-stream", "attachment")
  })

  // A preview: only a part and a stored file that both scanned clean, of a type read from the content that previews.
  routes.get("/files/:id/preview", async (c) => {
    const access = await tickets.file(await scopeOf(c), c.req.param("id"))
    if (!access?.storedSha256) return notFound(c)
    const type = access.detectedType
    if (access.storedStatus !== "clean" || type === null || previewKind(access.status, type) === null)
      return c.json({ error: "preview_refused" }, 403)
    return serve(c, access, type === "text/plain" ? "text/plain; charset=utf-8" : type, "inline")
  })

  routes.get("/intake", async (c) => {
    if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403)
    const mode = c.req.query("mode")
    const flagged = c.req.query("flagged")
    if (mode !== undefined && !(INTAKE_FILTER_MODES as readonly string[]).includes(mode)) return invalid(c)
    if (flagged !== undefined && flagged !== "1") return invalid(c)
    try {
      return c.json(
        await tickets.intake({
          mode: mode as (typeof INTAKE_FILTER_MODES)[number] | undefined,
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
