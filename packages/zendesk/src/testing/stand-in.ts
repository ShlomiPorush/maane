import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A stand-in Zendesk API for tests, on 127.0.0.1. Files live on a second server (another origin), which the
 * API redirects to, the way Zendesk hands attachments to its content host. Every record is invented.
 */
export interface StandInFile {
  id: number
  name: string
  content: Buffer
  inline?: boolean
  /** "redirect": served by the file host after a redirect; "direct": served by the API host; "missing": 404. */
  serve: "redirect" | "direct" | "missing"
}

interface Comment {
  id: number
  public: boolean
  body: string
  files: StandInFile[]
}

interface Ticket {
  id: number
  status: string
  updatedAt: string
  comments: Comment[]
  /** The comments endpoint answers 404: deleted after the export listed it. */
  gone?: boolean
}

export class StandInZendesk {
  readonly email = "agent@example.com"
  readonly token = randomBytes(16).toString("hex")
  readonly authorization: string
  apiOrigin = ""
  fileOrigin = ""
  /** Authorization headers the file host received. Must stay empty. */
  readonly fileHostAuthorizations: string[] = []
  readonly requests: string[] = []
  /** After this many API requests every API request answers 500, to stop a run part way. */
  failAfter = Number.POSITIVE_INFINITY
  /** A collection whose next link points at another origin. */
  foreignLinkIn: string | null = null

  readonly tickets = new Map<number, Ticket>()
  /** The ticket export's change log; a cursor is a position in it. */
  readonly ticketLog: number[] = []
  readonly users = [1, 2, 3].map((id) => ({ id, name: `User ${id}`, email: `user${id}@example.com` }))
  readonly organizations = [1, 2, 3].map((id) => ({ id, name: `Organization ${id}`, updated_ts: 1000 + id }))
  #clock = Date.parse("2026-01-01T00:00:00Z")
  #rateLimited = new Set<string>()
  #api?: Server
  #files?: Server

  constructor() {
    this.authorization = `Basic ${Buffer.from(`${this.email}/token:${this.token}`).toString("base64")}`
    const file = (id: number, name: string, serve: StandInFile["serve"], size = 64, inline = false): StandInFile => ({
      id,
      name,
      content: randomBytes(size),
      serve,
      inline,
    })
    this.addTicket(1, "open", [
      {
        id: 11,
        public: true,
        body: "Question",
        files: [file(101, "invoice.pdf", "redirect"), file(102, "a.png", "direct", 32, true)],
      },
      { id: 12, public: false, body: "Internal note", files: [] },
      { id: 13, public: true, body: "Answer", files: [] },
    ])
    this.addTicket(2, "pending", [
      { id: 21, public: true, body: "Big file", files: [file(201, "big.zip", "redirect", 4096)] },
    ])
    this.addTicket(3, "solved", [
      { id: 31, public: true, body: "Lost file", files: [file(301, "lost.txt", "missing")] },
    ])
    this.addTicket(4, "deleted", [])
    this.addTicket(5, "closed", [], true)
  }

  addTicket(id: number, status: string, comments: Comment[], gone = false): void {
    this.tickets.set(id, { id, status, updatedAt: this.#tick(), comments, gone })
    this.ticketLog.push(id)
  }

  /** A new comment on an existing ticket: a new version in the export. */
  addComment(ticketId: number, comment: Comment): void {
    const ticket = this.tickets.get(ticketId)
    if (!ticket) throw new Error(`no ticket ${ticketId}`)
    ticket.comments.push(comment)
    ticket.updatedAt = this.#tick()
    this.ticketLog.push(ticketId)
  }

  allFiles(): StandInFile[] {
    return [...this.tickets.values()].flatMap((t) => t.comments.flatMap((c) => c.files))
  }

  async start(): Promise<void> {
    this.#api = await listen((req, res) => this.#handleApi(req, res))
    this.#files = await listen((req, res) => this.#handleFiles(req, res))
    this.apiOrigin = `http://127.0.0.1:${(this.#api.address() as AddressInfo).port}`
    this.fileOrigin = `http://127.0.0.1:${(this.#files.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    await Promise.all([close(this.#api), close(this.#files)])
  }

  #tick(): string {
    this.#clock += 60_000
    return new Date(this.#clock).toISOString().replace(".000Z", "Z")
  }

  #handleApi(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.apiOrigin)
    this.requests.push(`${url.pathname}${url.search}`)
    if (this.requests.length > this.failAfter) return send(res, 500, { error: "stand-in stopped" })
    if (url.pathname.startsWith("/attachments/token/")) return this.#attachment(url, res)
    if (req.headers.authorization !== this.authorization) return send(res, 401, { error: "Couldn't authenticate you" })

    // The first request of the users export is rate limited once.
    if (url.pathname.includes("/incremental/users/") && !this.#rateLimited.has("users")) {
      this.#rateLimited.add("users")
      res.writeHead(429, { "Retry-After": "0" })
      return void res.end()
    }

    const path = url.pathname
    if (path === "/api/v2/incremental/tickets/cursor.json") return this.#ticketExport(url, res)
    if (path === "/api/v2/incremental/users/cursor.json") {
      return this.#cursorExport(url, res, "users", this.users, 2)
    }
    if (path === "/api/v2/incremental/organizations.json") return this.#organizationExport(url, res)
    const ticketMatch = /^\/api\/v2\/tickets\/(\d+)\/(comments|audits)\.json$/.exec(path)
    if (ticketMatch) return this.#ticketDetail(url, res, Number(ticketMatch[1]), ticketMatch[2] as string)
    const collection = /^\/api\/v2\/([a-z_]+)\.json$/.exec(path)?.[1]
    if (collection) return this.#collection(url, res, collection)
    send(res, 404, { error: "InvalidEndpoint" })
  }

  #ticketExport(url: URL, res: ServerResponse) {
    const start = Number(url.searchParams.get("cursor")?.replace("pos-", "") ?? 0)
    const end = Math.min(start + 2, this.ticketLog.length)
    const ids = [...new Set(this.ticketLog.slice(start, end))]
    const tickets = ids.map((id) => {
      const t = this.tickets.get(id) as Ticket
      return { id: t.id, encoded_id: `X${t.id}Y`, status: t.status, updated_at: t.updatedAt, subject: `Ticket ${t.id}` }
    })
    send(res, 200, {
      tickets,
      after_cursor: `pos-${end}`,
      after_url: `${this.apiOrigin}${url.pathname}?cursor=pos-${end}`,
      end_of_stream: end >= this.ticketLog.length,
    })
  }

  #cursorExport(url: URL, res: ServerResponse, key: string, records: unknown[], size: number) {
    const start = Number(url.searchParams.get("cursor")?.replace("pos-", "") ?? 0)
    const end = Math.min(start + size, records.length)
    send(res, 200, {
      [key]: records.slice(start, end),
      after_cursor: `pos-${end}`,
      end_of_stream: end >= records.length,
    })
  }

  #organizationExport(url: URL, res: ServerResponse) {
    const start = Number(url.searchParams.get("start_time") ?? 0)
    const page = this.organizations.filter((o) => o.updated_ts >= start).slice(0, 2)
    const last = page.at(-1)?.updated_ts ?? start
    const end = page.length < 2 || !this.organizations.some((o) => o.updated_ts > last)
    send(res, 200, { organizations: page, end_time: last + 1, end_of_stream: end, count: page.length })
  }

  #ticketDetail(url: URL, res: ServerResponse, id: number, kind: string) {
    const ticket = this.tickets.get(id)
    if (!ticket || ticket.gone || ticket.status === "deleted") return send(res, 404, { error: "RecordNotFound" })
    if (kind === "audits") {
      return send(res, 200, {
        audits: ticket.comments.map((c) => ({ id: c.id * 10, ticket_id: id, events: [{ type: "Comment", id: c.id }] })),
        meta: { has_more: false },
        links: { next: null },
      })
    }
    const inline = url.searchParams.get("include_inline_images") === "true"
    const after = Number(url.searchParams.get("page[after]") ?? 0)
    const page = ticket.comments.slice(after, after + 2)
    const more = after + 2 < ticket.comments.length
    send(res, 200, {
      comments: page.map((c) => ({
        id: c.id,
        public: c.public,
        body: c.body,
        attachments: c.files
          .filter((f) => inline || !f.inline)
          .map((f) => ({
            id: f.id,
            file_name: f.name,
            content_url: `${this.apiOrigin}/attachments/token/t${f.id}/?name=${encodeURIComponent(f.name)}`,
            content_type: "application/octet-stream",
            size: f.content.length,
            inline: f.inline === true,
          })),
      })),
      meta: { has_more: more },
      links: {
        next: more ? `${this.apiOrigin}${url.pathname}?page[after]=${after + 2}&include_inline_images=${inline}` : null,
      },
    })
  }

  #collection(url: URL, res: ServerResponse, name: string) {
    const after = Number(url.searchParams.get("page[after]") ?? 0)
    const records = [1, 2, 3].map((id) => ({ id, name: `${name} ${id}` }))
    const page = records.slice(after, after + 2)
    const more = after + 2 < records.length
    const origin = this.foreignLinkIn === name ? "https://other.example.com" : this.apiOrigin
    send(res, 200, {
      [name]: page,
      meta: { has_more: more },
      links: { next: more ? `${origin}${url.pathname}?page[after]=${after + 2}` : null },
    })
  }

  #attachment(url: URL, res: ServerResponse) {
    const id = Number(/\/t(\d+)\//.exec(url.pathname)?.[1])
    const file = this.allFiles().find((f) => f.id === id)
    if (!file || file.serve === "missing") return send(res, 404, { error: "not found" })
    if (file.serve === "direct") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": file.content.length })
      return void res.end(file.content)
    }
    res.writeHead(302, { Location: `${this.fileOrigin}/f/${file.id}` })
    res.end()
  }

  #handleFiles(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.authorization) this.fileHostAuthorizations.push(req.headers.authorization)
    const id = Number(/^\/f\/(\d+)$/.exec(req.url ?? "")?.[1])
    const file = this.allFiles().find((f) => f.id === id)
    if (!file) return send(res, 404, { error: "not found" })
    // No Content-Length: the size limit must hold while streaming, too.
    res.writeHead(200, { "Content-Type": "application/octet-stream" })
    res.end(file.content)
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

function close(server?: Server): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()))
}
