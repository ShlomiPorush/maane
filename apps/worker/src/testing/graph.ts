import { randomBytes, randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer, type Server } from "node:https"
import type { AddressInfo } from "node:net"
import tls from "node:tls"
import type { GraphFolder } from "@maane/shared"
import { generate } from "selfsigned"
import type { GraphConfig, GraphEndpoints } from "../intake/graph.ts"

// A stand-in for Microsoft Entra's token endpoint and the part of Microsoft Graph intake reads, for integration tests
// and the stack check. It speaks HTTPS with a certificate made for this run, because @azure/identity accepts only an
// https authority host; tests trust it through Node's documented tls.setDefaultCACertificates. It accepts only the
// client secret it generated for this run. Tests never reach Microsoft.
//
// Graph: delta queries of a folder's messages with paging (nextLink, deltaLink), `@removed` entries, `$value`, a 404
// for a vanished message, an expired delta token (410 SyncStateNotFound), throttling (429 with Retry-After), refusal
// (the connection is cut), a $value held until the test releases it, and mailboxes the application may not read (403).

interface Stored {
  id: string
  mailbox: string
  folder: GraphFolder
  raw: Buffer
  receivedAt: Date
  addedSeq: number
  removedSeq: number | null
  /** $value answers 404 while the message still shows in the delta query. */
  vanished: boolean
  failing: boolean
}

interface Snapshot {
  items: object[]
  endSeq: number
  mailbox: string
  folder: GraphFolder
}

export interface StandInGraph {
  tenantId: string
  clientId: string
  /** Generated for this run: the only secret the token endpoint accepts. */
  clientSecret: string
  /** The mailbox the application may read; allow() adds others. */
  mailbox: string
  /** For the gateway: the stand-in's authority host and Graph base URL. */
  endpoints: GraphEndpoints
  /** The settings values that reach this stand-in's mailbox. */
  config(mailbox?: string): GraphConfig
  /** Every request, as "METHOD path?query". */
  requests: string[]
  /** Graph requests that did not ask for immutable IDs. */
  withoutImmutableIds: string[]
  pageSize: number
  /** Adds a message to a folder; returns its immutable ID. */
  add(raw: Buffer, options?: { mailbox?: string; folder?: GraphFolder; receivedAt?: Date }): string
  /** The message is deleted: an `@removed` entry in the next delta round, and 404 on $value. */
  remove(id: string): void
  /** $value answers 404, while the delta query still lists the message. */
  vanish(id: string): void
  /** $value answers 500 until further notice (a failure that is not final). */
  fail(id: string): void
  /** Every delta and skip token issued so far answers 410 SyncStateNotFound. */
  expireTokens(): void
  /** The next `count` Graph requests answer 429 with Retry-After: 1. */
  throttle(count: number): void
  /** While on, every request is cut off without an answer, as an unreachable Graph. */
  refuse(on: boolean): void
  allow(mailbox: string): void
  deny(mailbox: string): void
  /** Holds the next $value request of this message until release() is called. */
  hold(id: string): { reached: Promise<void>; release: () => void }
  close(): Promise<void>
}

/** The CA certificates this process trusted before any stand-in, and the stand-ins' certificates trusted since. */
let systemCertificates: string[] | null = null
const trusted: string[] = []

/** Trusts a stand-in's certificate for this process's TLS clients (Node's tls.setDefaultCACertificates). */
export function trustCertificate(cert: string): void {
  systemCertificates ??= tls.getCACertificates("default")
  trusted.push(cert)
  tls.setDefaultCACertificates([...systemCertificates, ...trusted])
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

const graphError = (res: ServerResponse, status: number, code: string, message: string) =>
  json(res, status, { error: { code, message } })

/** The first value of a header in raw MIME, unfolded. */
function headerOf(raw: Buffer, name: string): string | null {
  const head = raw.toString("latin1").split(/\r?\n\r?\n/)[0] ?? ""
  const match = new RegExp(`^${name}:[ \\t]*((?:.*)(?:\\r?\\n[ \\t].*)*)`, "im").exec(head)
  return match?.[1] ? match[1].replace(/\r?\n[ \t]+/g, " ").trim() : null
}

export async function startStandInGraph(options: { trust?: boolean } = {}): Promise<StandInGraph> {
  // A subject of its own: OpenSSL finds a self-signed certificate among the trusted ones by its subject, so two
  // stand-ins with one subject would be mistaken for each other.
  const pems = await generate([{ name: "commonName", value: `maane-stand-in-${randomBytes(8).toString("hex")}` }], {
    keyType: "ec",
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
        ],
      },
    ],
  })
  if (options.trust !== false) trustCertificate(pems.cert)

  const tenantId = randomUUID()
  const clientId = randomUUID()
  const clientSecret = randomBytes(30).toString("base64url")
  const mailbox = `intake-${randomBytes(4).toString("hex")}@example.com`
  const allowed = new Set([mailbox])
  const tokens = new Set<string>()
  const messages = new Map<string, Stored>()
  const snapshots = new Map<string, Snapshot>()
  const holds = new Map<string, { reached: () => void; released: Promise<void> }>()
  let seq = 0
  let generation = 1
  let throttled = 0
  let refusing = false
  let base = ""

  const itemOf = (message: Stored) => ({
    "@odata.type": "#microsoft.graph.message",
    id: message.id,
    receivedDateTime: message.receivedAt.toISOString(),
    internetMessageId: headerOf(message.raw, "Message-ID"),
    subject: headerOf(message.raw, "Subject"),
    from: { emailAddress: { address: /<([^>]+)>/.exec(headerOf(message.raw, "From") ?? "")?.[1] ?? null } },
    parentFolderId: message.folder,
  })

  const deltaPage = (res: ServerResponse, snapshotKey: string, offset: number) => {
    const snapshot = snapshots.get(snapshotKey)
    if (!snapshot) return graphError(res, 410, "SyncStateNotFound", "The sync state was not found.")
    const page = snapshot.items.slice(offset, offset + standIn.pageSize)
    const link = `${base}v1.0/users/${encodeURIComponent(snapshot.mailbox)}/mailFolders/${snapshot.folder}/messages/delta`
    const more = offset + standIn.pageSize < snapshot.items.length
    json(res, 200, {
      value: page,
      ...(more
        ? { "@odata.nextLink": `${link}?$skiptoken=${generation}.${snapshotKey}.${offset + standIn.pageSize}` }
        : { "@odata.deltaLink": `${link}?$deltatoken=${generation}.${snapshot.endSeq}` }),
    })
  }

  const delta = (res: ServerResponse, url: URL, box: string, folder: GraphFolder) => {
    const skip = url.searchParams.get("$skiptoken")
    const token = url.searchParams.get("$deltatoken")
    const expired = (value: string) => Number(value.split(".")[0]) !== generation
    if (skip) {
      if (expired(skip)) return graphError(res, 410, "SyncStateNotFound", "The sync state was not found.")
      const [, key = "", offset = "0"] = skip.split(".")
      return deltaPage(res, key, Number(offset))
    }
    let items: object[]
    if (token) {
      if (expired(token)) return graphError(res, 410, "SyncStateNotFound", "The sync state was not found.")
      const since = Number(token.split(".")[1])
      items = []
      for (const message of messages.values()) {
        if (message.mailbox !== box || message.folder !== folder) continue
        if (message.removedSeq !== null && message.removedSeq > since)
          items.push({ "@odata.type": "#microsoft.graph.message", id: message.id, "@removed": { reason: "deleted" } })
        else if (message.removedSeq === null && message.addedSeq > since) items.push(itemOf(message))
      }
    } else {
      items = [...messages.values()]
        .filter((message) => message.mailbox === box && message.folder === folder && message.removedSeq === null)
        .sort((a, b) => a.addedSeq - b.addedSeq)
        .map(itemOf)
    }
    const key = randomBytes(6).toString("hex")
    snapshots.set(key, { items, endSeq: seq, mailbox: box, folder })
    deltaPage(res, key, 0)
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    let body = ""
    for await (const chunk of req) body += chunk
    standIn.requests.push(`${req.method} ${req.url}`)
    if (refusing) {
      req.socket.destroy()
      return
    }
    const url = new URL(req.url ?? "/", "https://127.0.0.1")
    const path = decodeURIComponent(url.pathname)

    // Entra: the OpenID configuration of a tenant, and its token endpoint (client credentials only).
    const openid = /^\/([^/]+)\/v2\.0\/\.well-known\/openid-configuration$/.exec(path)
    if (openid?.[1]) {
      const tenant = `${base}${openid[1]}`
      return json(res, 200, {
        token_endpoint: `${tenant}/oauth2/v2.0/token`,
        issuer: `${tenant}/v2.0`,
        authorization_endpoint: `${tenant}/oauth2/v2.0/authorize`,
        end_session_endpoint: `${tenant}/oauth2/v2.0/logout`,
        jwks_uri: `${tenant}/discovery/v2.0/keys`,
        response_types_supported: ["code"],
      })
    }
    const token = /^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(path)
    if (token) {
      const form = new URLSearchParams(body)
      if (token[1] !== tenantId)
        return json(res, 400, { error: "invalid_request", error_description: "AADSTS90002: Tenant not found." })
      if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret)
        return json(res, 401, {
          error: "invalid_client",
          error_description: "AADSTS7000215: Invalid client secret provided.",
        })
      const access = randomBytes(24).toString("hex")
      tokens.add(access)
      return json(res, 200, { token_type: "Bearer", expires_in: 3599, ext_expires_in: 3599, access_token: access })
    }

    // Graph.
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1]
    if (!bearer || !tokens.has(bearer))
      return graphError(res, 401, "InvalidAuthenticationToken", "Access token is empty or invalid.")
    if (!/IdType="ImmutableId"/.test(String(req.headers.prefer ?? ""))) standIn.withoutImmutableIds.push(path)
    if (throttled > 0) {
      throttled--
      return json(
        res,
        429,
        { error: { code: "TooManyRequests", message: "Too many requests." } },
        { "retry-after": "1" },
      )
    }
    const users = /^\/v1\.0\/users\/([^/]+)\/(.+)$/.exec(path)
    if (!users?.[1] || !users[2]) return graphError(res, 404, "ResourceNotFound", "Not found.")
    const box = users[1].toLowerCase()
    if (!allowed.has(box)) return graphError(res, 403, "ErrorAccessDenied", "Access is denied.")
    const rest = users[2]
    const folderMatch = /^mailFolders\/(inbox|junkemail)$/.exec(rest)
    if (folderMatch) return json(res, 200, { id: `folder-${folderMatch[1]}`, displayName: folderMatch[1] })
    const deltaMatch = /^mailFolders\/(inbox|junkemail)\/messages\/delta$/.exec(rest)
    if (deltaMatch) return delta(res, url, box, deltaMatch[1] as GraphFolder)
    const value = /^messages\/([^/]+)\/\$value$/.exec(rest)
    if (value?.[1]) {
      const message = messages.get(value[1])
      const hold = holds.get(value[1])
      if (hold) {
        holds.delete(value[1])
        hold.reached()
        await hold.released
      }
      if (message?.failing) return graphError(res, 500, "InternalServerError", "Something went wrong.")
      if (!message || message.mailbox !== box || message.removedSeq !== null || message.vanished)
        return graphError(res, 404, "ErrorItemNotFound", "The specified object was not found in the store.")
      res.writeHead(200, { "content-type": "message/rfc822" })
      return res.end(message.raw)
    }
    return graphError(res, 404, "ResourceNotFound", "Not found.")
  }

  const server: Server = createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    handle(req, res).catch(() => res.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`

  const standIn: StandInGraph = {
    tenantId,
    clientId,
    clientSecret,
    mailbox,
    endpoints: { authorityHost: base.slice(0, -1), baseUrl: base },
    config: (box = mailbox) => ({ tenantId, clientId, clientSecret, mailbox: box }),
    requests: [],
    withoutImmutableIds: [],
    pageSize: 10,
    add(raw, options = {}) {
      const id = `AAMk${randomBytes(12).toString("base64url")}=`
      seq++
      messages.set(id, {
        id,
        mailbox: (options.mailbox ?? mailbox).toLowerCase(),
        folder: options.folder ?? "inbox",
        raw,
        receivedAt: options.receivedAt ?? new Date(Date.now() + seq),
        addedSeq: seq,
        removedSeq: null,
        vanished: false,
        failing: false,
      })
      return id
    },
    remove(id) {
      const message = messages.get(id)
      if (!message) throw new Error("no such message")
      seq++
      message.removedSeq = seq
    },
    vanish(id) {
      const message = messages.get(id)
      if (!message) throw new Error("no such message")
      message.vanished = true
    },
    fail(id) {
      const message = messages.get(id)
      if (!message) throw new Error("no such message")
      message.failing = true
    },
    expireTokens() {
      generation++
      snapshots.clear()
    },
    throttle(count) {
      throttled = count
    },
    refuse(on) {
      refusing = on
    },
    allow(box) {
      allowed.add(box.toLowerCase())
    },
    deny(box) {
      allowed.delete(box.toLowerCase())
    },
    hold(id) {
      let reached!: () => void
      let release!: () => void
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve
      })
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      holds.set(id, { reached, released })
      return { reached: reachedPromise, release }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const hold of holds.values()) hold.reached()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  return standIn
}
