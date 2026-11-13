import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:https"
import { trustCertificate } from "./graph.ts"
import { standInCertificate } from "./smtp.ts"

// A stand-in for SMTP2GO's activity search (plan 3.3), `POST /v3/activity/search` as SMTP2GO documents it: HTTPS with a
// certificate made for this stand-in (trusted in this process only), and an API key generated for the run, the only
// one it accepts (`X-Smtp2go-Api-Key`). It answers the events a test gave it whose date falls in the request's window
// (start inclusive, end exclusive), a page of `limit` at a time with a `continue_token`, and keeps every request's
// body. Nothing real is ever called.

export interface ActivityEventFixture {
  event: string
  email_id: string
  recipient: string
  /** RFC 3339 in UTC. */
  date: string
  reason?: string
}

export interface StandInSmtp2goApi {
  /** The base URL, as `https://127.0.0.1:<port>/v3`. */
  baseUrl: string
  apiKey: string
  events: ActivityEventFixture[]
  /** Every request's JSON body, in order, and whether its key was accepted. */
  requests: { body: Record<string, unknown>; authorized: boolean }[]
  /** Makes every request fail with this status until cleared (null). */
  failWith: number | null
  close(): Promise<void>
}

export async function startStandInSmtp2goApi(): Promise<StandInSmtp2goApi> {
  const pems = await standInCertificate()
  trustCertificate(pems.cert)
  const apiKey = `api-${randomBytes(16).toString("hex")}`
  const state: Omit<StandInSmtp2goApi, "baseUrl" | "close"> = { apiKey, events: [], requests: [], failWith: null }
  const pages = new Map<string, ActivityEventFixture[]>()

  const server: Server = createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
      }
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        return reply(400, { data: { error: "bad json" } })
      }
      const authorized = req.headers["x-smtp2go-api-key"] === apiKey
      state.requests.push({ body, authorized })
      if (req.method !== "POST" || req.url !== "/v3/activity/search") return reply(404, { data: { error: "no" } })
      if (!authorized) return reply(401, { data: { error: "unauthorized" } })
      if (state.failWith !== null) return reply(state.failWith, { data: { error: "failing" } })
      const limit = typeof body.limit === "number" ? body.limit : 100
      let rest: ActivityEventFixture[]
      const token = typeof body.continue_token === "string" ? body.continue_token : null
      if (token) {
        rest = pages.get(token) ?? []
        pages.delete(token)
      } else {
        const start = Date.parse(String(body.start_date))
        const end = Date.parse(String(body.end_date))
        const types = Array.isArray(body.event_types) ? body.event_types : null
        rest = state.events.filter((event) => {
          const at = Date.parse(event.date)
          return at >= start && at < end && (types === null || types.includes(event.event))
        })
      }
      const page = rest.slice(0, limit)
      let next: string | null = null
      if (rest.length > limit) {
        next = randomBytes(8).toString("hex")
        pages.set(next, rest.slice(limit))
      }
      reply(200, {
        request_id: randomBytes(8).toString("hex"),
        data: { events: page, total_events: rest.length, continue_token: next },
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("the stand-in API has no port")
  return Object.assign(state, {
    baseUrl: `https://127.0.0.1:${address.port}/v3`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  })
}
