import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { CLICK_BOUNDS, CLICKS_SHOWN, MESSAGES, REFERENCE_ALPHABET, type TicketView } from "@maane/shared"
import { parse as parseDisposition } from "content-disposition"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  authUser,
  intakeSource,
  linkClick,
  message,
  messagePart,
  organization,
  outbox,
  outboxRecipient,
  storedFile,
  ticket,
  trackedLink,
} from "../db/schema.ts"
import { applyDeliveryEvent } from "../delivery/service.ts"
import { storedFilePath } from "../files/paths.ts"
import { LINK_RATE_LIMIT } from "../http/links.ts"
import { createTestApp } from "../testing/app.ts"
import { nextIp, TestBrowser, testPassword } from "../testing/browser.ts"
import { createTestDatabase } from "../testing/db.ts"
import { pdf } from "../testing/files.ts"
import { newCode } from "./service.ts"

// The public link routes of plan 3.4 against a migrated database, a file store in a temporary directory, and the
// GeoLite2 test databases (documentation networks only). Links are planted as a reply writes them. The client address
// comes from the TCP peer, so the tests that need it serve the app on a port of 127.0.0.1.

const GEOIP = fileURLToPath(new URL("../testing/geoip/", import.meta.url))
const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36"
const FILE_CSP = "default-src 'none'; sandbox"

let database: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createTestApp>
let filesDir: string
let sourceId: string
let servers: { close: () => void }[] = []
const password = testPassword()

async function start(links: { trustedProxies?: string[]; geoipDir?: string | null } = { geoipDir: GEOIP }) {
  app = createTestApp(database, {}, undefined, filesDir, links)
  await app.ready
}

beforeEach(async () => {
  database = await createTestDatabase()
  filesDir = await mkdtemp(join(tmpdir(), "maane-links-"))
  await start()
  const [source] = await database.db
    .insert(intakeSource)
    .values({ tenantId: `tenant-${randomBytes(4).toString("hex")}`, mailbox: "intake@example.com" })
    .returning({ id: intakeSource.id })
  sourceId = source?.id ?? ""
})
afterEach(async () => {
  for (const server of servers) server.close()
  servers = []
  await app.close()
  await database.drop()
  await rm(filesDir, { recursive: true, force: true })
})

const db = () => database.db

/** The app served on a port of 127.0.0.1: requests then have a TCP peer, 127.0.0.1. */
async function listening(): Promise<string> {
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s))
  })
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A request straight to the app's fetch: no TCP peer at all. */
const get = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://127.0.0.1:8090${path}`, { headers }))

const reference = () =>
  Array.from({ length: 8 }, (_, i) => (i === 4 ? "-" : "") + REFERENCE_ALPHABET[i % REFERENCE_ALPHABET.length]).join("")

/** A ticket with a customer's message: returns their IDs. */
async function customerMessage() {
  const [org] = await db().insert(organization).values({ name: "Example Support" }).returning({ id: organization.id })
  const [t] = await db()
    .insert(ticket)
    .values({
      referenceCode: reference(),
      organizationId: org?.id ?? "",
      supportAddress: "help@example.com",
      subject: "Hello",
    })
    .returning({ id: ticket.id, number: ticket.number })
  const [m] = await db()
    .insert(message)
    .values({
      sourceId,
      graphId: randomBytes(8).toString("hex"),
      folder: "inbox",
      receivedAt: new Date(),
      state: "processed",
      content: "parsed",
      graph: { subject: "Hello" },
      fromAddress: "dana@example.com",
      subject: "Hello",
      textBody: "Hello",
      ticketId: t?.id,
    })
    .returning({ id: message.id })
  return { ticketId: t?.id ?? "", number: t?.number ?? 0, messageId: m?.id ?? "" }
}

/**
 * A message an agent wrote (`out` or `note`); a reply with an outbox row whose recipient a provider accepted at
 * `acceptedAt` and, with `deliveredAt`, SMTP2GO reported delivered then (plan 3.3). The row's `updated_at` is always
 * now, as a delivery event leaves it: the scanner mark must not read it.
 */
async function agentMessage(
  ticketId: string,
  userId: string,
  direction: "out" | "note",
  {
    acceptedAt = new Date(),
    deliveredAt = null,
    providerId = null,
  }: { acceptedAt?: Date; deliveredAt?: Date | null; providerId?: string | null } = {},
) {
  const [m] = await db()
    .insert(message)
    .values({
      direction,
      ticketId,
      receivedAt: new Date(),
      state: "processed",
      content: "parsed",
      authorUserId: userId,
      submissionId: randomUUID(),
      textBody: "An answer",
    })
    .returning({ id: message.id })
  const id = m?.id ?? ""
  if (direction === "out") {
    await db()
      .insert(outbox)
      .values({
        messageId: id,
        mime: Buffer.from("x"),
        messageIdHeader: `${randomUUID()}@example.com`,
        fromAddress: "help@example.com",
        state: "accepted",
      })
    await db()
      .insert(outboxRecipient)
      .values({
        messageId: id,
        address: "dana@example.com",
        kind: "to",
        position: 0,
        state: "accepted",
        provider: "smtp2go",
        providerId,
        acceptedAt,
        ...(deliveredAt
          ? { delivery: "delivered", deliveryAt: deliveredAt, deliverySource: "webhook", firstDeliveredAt: deliveredAt }
          : {}),
        updatedAt: new Date(),
      })
  }
  return id
}

let partIndex = 0
/** A file part of a message, stored when its status is a stored one. */
async function filePart(messageId: string, status = "clean", bytes = pdf()) {
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const stored = ["clean", "not_fully_scanned", "not_scanned"].includes(status)
  if (stored) {
    const path = storedFilePath(filesDir, sha256)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    await db()
      .insert(storedFile)
      .values({ sha256, size: bytes.length, detectedType: "application/pdf", scanStatus: status })
      .onConflictDoNothing()
  }
  const [row] = await db()
    .insert(messagePart)
    .values({
      messageId,
      index: partIndex++,
      kind: "attachment",
      fileName: "invoice\r\n2026.pdf",
      size: bytes.length,
      sha256,
      status,
      storedSha256: stored ? sha256 : null,
    })
    .returning({ id: messagePart.id })
  return row?.id ?? ""
}

/** A link a reply carried, as the reply writes it. */
async function plant(replyId: string, target: { url: string } | { partId: string }) {
  const code = newCode()
  const [row] = await db()
    .insert(trackedLink)
    .values(
      "url" in target
        ? { code, messageId: replyId, kind: "url", url: target.url }
        : { code, messageId: replyId, kind: "file", partId: target.partId },
    )
    .returning({ id: trackedLink.id })
  return { code, id: row?.id ?? "" }
}

async function admin() {
  const b = new TestBrowser(app.fetch, nextIp())
  expect((await b.setup("first.admin", password)).status).toBe(200)
  await b.enroll(password)
  const [user] = await db().select({ id: authUser.id }).from(authUser)
  return { b, id: user?.id ?? "" }
}

/** A reply on a new ticket, and its message. */
async function reply() {
  const { b, id } = await admin()
  const customer = await customerMessage()
  return { b, ...customer, replyId: await agentMessage(customer.ticketId, id, "out"), userId: id }
}

const clicks = (linkId: string) => db().select().from(linkClick).where(eq(linkClick.linkId, linkId))

/** The short plain page an unknown code gets, in the default language. */
async function expectUnknown(response: Response) {
  expect(response.status).toBe(404)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("location")).toBeNull()
  const body = await response.text()
  expect(body).toContain(MESSAGES.he.links.unknown)
  expect(body).toContain('<html lang="he" dir="rtl">')
}

describe("tracked links", () => {
  it("redirects only to the stored link, never caching, and records the click", async () => {
    const { replyId } = await reply()
    const link = await plant(replyId, { url: "https://www.example.com/guide?a=1&b=2" })
    // Anything the request carries besides the code is ignored.
    const answer = await get(`/l/${link.code}?url=https%3A%2F%2Fevil.example.com%2F&to=https://evil.example.com/`, {
      "user-agent": CHROME,
    })
    expect(answer.status).toBe(302)
    expect(answer.headers.get("location")).toBe("https://www.example.com/guide?a=1&b=2")
    expect(answer.headers.get("cache-control")).toBe("no-store")
    expect(answer.headers.get("referrer-policy")).toBe("no-referrer")
    const [click] = await clicks(link.id)
    expect(click).toMatchObject({ device: "desktop", browser: "Chrome 131", os: "Windows 10", userAgent: CHROME })
  })

  it("answers an unknown code, a malformed one, and a URL in place of a code with a plain page, never a redirect", async () => {
    const { b, replyId } = await reply()
    await plant(replyId, { url: "https://www.example.com/" })
    for (const path of [
      `/l/${newCode()}`,
      "/l/short",
      `/l/${encodeURIComponent("https://evil.example.com/")}`,
      "/l/https://evil.example.com/",
      `/f/${newCode()}`,
    ])
      await expectUnknown(await get(path))
    // The default language decides the page's words.
    expect((await b.call("PUT", "/api/v1/settings", { "general.defaultLocale": "en" })).status).toBe(200)
    const english = await get(`/l/${newCode()}`)
    const text = await english.text()
    expect(text).toContain(MESSAGES.en.links.unknown)
    expect(text).toContain('<html lang="en" dir="ltr">')
  })

  it("takes the client address from the forwarding header only behind a trusted proxy, and locates it", async () => {
    const { replyId } = await reply()
    const link = await plant(replyId, { url: "https://www.example.com/" })
    // Not trusted: the forged header is ignored, and the TCP peer is recorded.
    let base = await listening()
    expect(
      (await fetch(`${base}/l/${link.code}`, { redirect: "manual", headers: { "x-forwarded-for": "192.0.2.10" } }))
        .status,
    ).toBe(302)
    // Trusted: the address before the proxy, with its location from the GeoLite2 files.
    await app.close()
    await start({ trustedProxies: ["127.0.0.1"], geoipDir: GEOIP })
    base = await listening()
    const forwarded = { "x-forwarded-for": "203.0.113.9, 192.0.2.10", "user-agent": CHROME }
    expect((await fetch(`${base}/l/${link.code}`, { redirect: "manual", headers: forwarded })).status).toBe(302)
    const recorded = (await clicks(link.id)).map((click) => ({ ...click, id: 0, at: null }))
    expect(recorded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ip: "127.0.0.1", country: null, asn: null }),
        expect.objectContaining({
          ip: "192.0.2.10",
          country: "il",
          city: "Tel Aviv",
          region: "Tel Aviv District",
          isp: "Example Net",
          asn: 64496,
          device: "desktop",
        }),
      ]),
    )
  })

  it("rate limits per client address: a forged header from an untrusted peer does not get a new allowance", async () => {
    const { replyId } = await reply()
    const link = await plant(replyId, { url: "https://www.example.com/" })
    const base = await listening()
    const statuses: number[] = []
    for (let i = 0; i <= LINK_RATE_LIMIT; i++) {
      const forged = `192.0.2.${(i % 250) + 1}`
      const answer = await fetch(`${base}/l/${link.code}`, {
        redirect: "manual",
        headers: { "x-forwarded-for": forged },
      })
      statuses.push(answer.status)
      if (answer.status === 429) {
        expect(answer.headers.get("cache-control")).toBe("no-store")
        expect(await answer.text()).toContain(MESSAGES.he.links.busy)
      } else await answer.arrayBuffer()
    }
    expect(statuses.slice(0, LINK_RATE_LIMIT).every((status) => status === 302)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
    // The download route shares the allowance.
    expect((await fetch(`${base}/f/${newCode()}`)).status).toBe(429)
  })

  it("gives each forwarded client its own allowance behind a trusted proxy", async () => {
    await app.close()
    await start({ trustedProxies: ["127.0.0.1"], geoipDir: null })
    const { replyId } = await reply()
    const link = await plant(replyId, { url: "https://www.example.com/" })
    const base = await listening()
    const ask = async (client: string) => {
      const answer = await fetch(`${base}/l/${link.code}`, {
        redirect: "manual",
        headers: { "x-forwarded-for": client },
      })
      await answer.arrayBuffer()
      return answer.status
    }
    for (let i = 0; i < LINK_RATE_LIMIT; i++) expect(await ask("192.0.2.1")).toBe(302)
    expect(await ask("192.0.2.1")).toBe(429)
    expect(await ask("192.0.2.2")).toBe(302)
  })

  it("bounds every string a click records", async () => {
    await app.close()
    await start({ trustedProxies: ["127.0.0.1"], geoipDir: GEOIP })
    const { replyId } = await reply()
    const link = await plant(replyId, { url: "https://www.example.com/" })
    const base = await listening()
    const agent = `${CHROME} ${"x".repeat(5000)}`
    await fetch(`${base}/l/${link.code}`, {
      redirect: "manual",
      headers: { "x-forwarded-for": "203.0.113.5", "user-agent": agent },
    })
    const [click] = await clicks(link.id)
    if (!click) throw new Error("no click")
    for (const key of Object.keys(CLICK_BOUNDS) as (keyof typeof CLICK_BOUNDS)[])
      expect((click[key] ?? "").length, key).toBeLessThanOrEqual(CLICK_BOUNDS[key])
    expect(click.userAgent).toHaveLength(CLICK_BOUNDS.userAgent)
    expect(click.city).toHaveLength(CLICK_BOUNDS.city)
    expect(click.isp).toHaveLength(CLICK_BOUNDS.isp)
  })

  it("records a click without a location when the GeoLite2 files are missing, and still redirects", async () => {
    await app.close()
    await start({ trustedProxies: ["127.0.0.1"], geoipDir: join(filesDir, "no-geoip") })
    const { replyId } = await reply()
    const link = await plant(replyId, { url: "https://www.example.com/" })
    const base = await listening()
    const answer = await fetch(`${base}/l/${link.code}`, {
      redirect: "manual",
      headers: { "x-forwarded-for": "192.0.2.10" },
    })
    expect(answer.status).toBe(302)
    expect(await clicks(link.id)).toEqual([
      expect.objectContaining({ ip: "192.0.2.10", country: null, city: null, region: null, isp: null, asn: null }),
    ])
  })

  it("records nothing while tracking is off, and links already sent keep working", async () => {
    const { b, replyId } = await reply()
    const link = await plant(replyId, { url: "https://www.example.com/" })
    expect((await b.call("PUT", "/api/v1/settings", { "links.tracking": "off" })).status).toBe(200)
    expect((await get(`/l/${link.code}`)).status).toBe(302)
    expect(await clicks(link.id)).toEqual([])
  })
})

describe("download links", () => {
  it("serves a history file as a download only, and records the download", async () => {
    const { messageId, replyId } = await reply()
    const link = await plant(replyId, { partId: await filePart(messageId) })
    const answer = await get(`/f/${link.code}`, { "user-agent": CHROME })
    expect(answer.status).toBe(200)
    expect(answer.headers.get("content-type")).toBe("application/octet-stream")
    expect(parseDisposition(answer.headers.get("content-disposition") ?? "")).toEqual({
      type: "attachment",
      parameters: { filename: "invoice__2026.pdf" },
    })
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff")
    expect(answer.headers.get("content-security-policy")).toBe(FILE_CSP)
    expect(answer.headers.get("cache-control")).toBe("no-store")
    expect(Buffer.from(await answer.arrayBuffer())).toEqual(pdf())
    expect(await clicks(link.id)).toHaveLength(1)
  })

  it("serves a file the owner's policy let through unscanned, as the ticket view's download does", async () => {
    const { messageId, replyId } = await reply()
    const link = await plant(replyId, { partId: await filePart(messageId, "not_scanned", Buffer.from("plain")) })
    expect((await get(`/f/${link.code}`)).status).toBe(200)
  })

  it("refuses a file of an internal note and a file that did not scan clean", async () => {
    const { ticketId, messageId, replyId, userId } = await reply()
    const note = await agentMessage(ticketId, userId, "note")
    const noteFile = await plant(replyId, { partId: await filePart(note, "clean", Buffer.from("team only")) })
    const infected = await plant(replyId, { partId: await filePart(messageId, "infected", Buffer.from("bad")) })
    const blocked = await plant(replyId, { partId: await filePart(messageId, "blocked_type", Buffer.from("exe")) })
    for (const link of [noteFile, infected, blocked]) {
      await expectUnknown(await get(`/f/${link.code}`))
      expect(await clicks(link.id)).toEqual([])
    }
    // A file code is never a tracked link, and a link code never a download.
    const url = await plant(replyId, { url: "https://www.example.com/" })
    const file = await plant(replyId, { partId: await filePart(messageId) })
    await expectUnknown(await get(`/f/${url.code}`))
    await expectUnknown(await get(`/l/${file.code}`))
  })

  it("is dead once its file or its ticket is deleted", async () => {
    const { ticketId, messageId, replyId } = await reply()
    const part = await filePart(messageId)
    const link = await plant(replyId, { partId: part })
    expect((await get(`/f/${link.code}`)).status).toBe(200)
    // The file deleted: its part goes, and its link with it.
    await db().delete(messagePart).where(eq(messagePart.id, part))
    await expectUnknown(await get(`/f/${link.code}`))
    expect(await db().select().from(trackedLink).where(eq(trackedLink.id, link.id))).toEqual([])

    // The ticket deleted: its messages and their parts go, and every link of its replies with them.
    const other = await plant(replyId, { partId: await filePart(messageId) })
    const tracked = await plant(replyId, { url: "https://www.example.com/" })
    await db().transaction(async (tx) => {
      await tx.delete(outboxRecipient).where(eq(outboxRecipient.messageId, replyId))
      await tx.delete(outbox).where(eq(outbox.messageId, replyId))
      await tx.delete(messagePart).where(eq(messagePart.messageId, messageId))
      await tx.delete(message).where(eq(message.ticketId, ticketId))
      await tx.delete(ticket).where(eq(ticket.id, ticketId))
    })
    await expectUnknown(await get(`/f/${other.code}`))
    await expectUnknown(await get(`/l/${tracked.code}`))
  })
})

describe("the ticket view", () => {
  it("shows each reply's clicked links and downloaded files with their clicks, newest first, and the scanner mark", async () => {
    await app.close()
    await start({ trustedProxies: ["127.0.0.1"], geoipDir: GEOIP })
    const { b, number, messageId, userId, ticketId } = await reply()
    // A reply a provider accepted ten minutes ago, its row written again just now by a delivery event.
    const sent = await agentMessage(ticketId, userId, "out", { acceptedAt: new Date(Date.now() - 600_000) })
    const guide = await plant(sent, { url: "https://www.example.com/guide" })
    const file = await plant(sent, { partId: await filePart(messageId) })
    await plant(sent, { url: "https://www.example.com/never-clicked" })
    const base = await listening()
    const open = (path: string, client: string, agent = CHROME) =>
      fetch(`${base}${path}`, { redirect: "manual", headers: { "x-forwarded-for": client, "user-agent": agent } }).then(
        (answer) => answer.arrayBuffer(),
      )
    await open(`/l/${guide.code}`, "198.51.100.20")
    await open(
      `/l/${guide.code}`,
      "192.0.2.10",
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    )
    await open(`/f/${file.code}`, "2001:db8::5")
    // A click right after sending.
    const early = await agentMessage(ticketId, userId, "out", { acceptedAt: new Date() })
    const fresh = await plant(early, { url: "https://www.example.com/fresh" })
    await open(`/l/${fresh.code}`, "192.0.2.11")
    // Accepted long ago but delivered only now (a queue at the provider): the delivery time counts.
    const late = await agentMessage(ticketId, userId, "out", {
      acceptedAt: new Date(Date.now() - 3_600_000),
      deliveredAt: new Date(),
    })
    const delivered = await plant(late, { url: "https://www.example.com/late" })
    await open(`/l/${delivered.code}`, "192.0.2.12")

    const answer = await b.call("GET", `/api/v1/tickets/${number}`)
    expect(answer.status).toBe(200)
    const view = answer.json as TicketView
    const links = view.messages.find((m) => m.id === sent)?.links
    expect(links).toEqual([
      {
        id: guide.id,
        kind: "url",
        target: "https://www.example.com/guide",
        total: 2,
        clicks: [
          expect.objectContaining({ ip: "192.0.2.10", country: "il", device: "bot", scanner: ["agent"] }),
          expect.objectContaining({
            ip: "198.51.100.20",
            country: "gb",
            city: "London",
            isp: "Example Scanning",
            asn: 64497,
            scanner: [],
          }),
        ],
      },
      {
        id: file.id,
        kind: "file",
        target: "invoice\r\n2026.pdf",
        total: 1,
        clicks: [expect.objectContaining({ ip: "2001:db8::5", country: "de", scanner: [] })],
      },
    ])
    expect(view.messages.find((m) => m.id === early)?.links).toEqual([
      {
        id: fresh.id,
        kind: "url",
        target: "https://www.example.com/fresh",
        total: 1,
        clicks: [expect.objectContaining({ scanner: ["early"] })],
      },
    ])
    expect(view.messages.find((m) => m.id === late)?.links?.[0]?.clicks).toEqual([
      expect.objectContaining({ ip: "192.0.2.12", scanner: ["early"] }),
    ])
    // Incoming messages carry none.
    expect(view.messages.find((m) => m.id === messageId)?.links).toEqual([])
  })
})

describe("a link a scanner keeps clicking", () => {
  it("keeps every click, and the ticket view shows the newest CLICKS_SHOWN with the total", async () => {
    const { b, number, replyId } = await reply()
    const link = await plant(replyId, { url: "https://www.example.com/" })
    const start = Date.now() - 3_600_000
    const total = CLICKS_SHOWN + 25
    await db()
      .insert(linkClick)
      .values(
        Array.from({ length: total }, (_, i) => ({
          linkId: link.id,
          at: new Date(start + i * 1000),
          ip: `192.0.2.${i}`,
        })),
      )
    expect(await clicks(link.id)).toHaveLength(total)
    const view = (await b.call("GET", `/api/v1/tickets/${number}`)).json as TicketView
    const [shown] = view.messages.find((m) => m.id === replyId)?.links ?? []
    expect(shown?.total).toBe(total)
    expect(shown?.clicks).toHaveLength(CLICKS_SHOWN)
    // The newest first: the last one recorded, down to the CLICKS_SHOWN-th newest.
    expect(shown?.clicks[0]?.ip).toBe(`192.0.2.${total - 1}`)
    expect(shown?.clicks.at(-1)?.ip).toBe(`192.0.2.${total - CLICKS_SHOWN}`)
  })
})

describe("the early mark after later delivery events (review L1)", () => {
  it("keeps a click early against the first delivery when a spam report replaces the status", async () => {
    await app.close()
    await start({ trustedProxies: ["127.0.0.1"], geoipDir: null })
    const { b, number, ticketId, userId } = await reply()
    // Accepted an hour ago; SMTP2GO reports it delivered 30 seconds ago, through 3.3's own write path.
    const queueId = `queue-${randomUUID()}`
    const sent = await agentMessage(ticketId, userId, "out", {
      acceptedAt: new Date(Date.now() - 3_600_000),
      providerId: queueId,
    })
    const event = (status: "delivered" | "spam", at: Date) =>
      db().transaction((tx) =>
        applyDeliveryEvent(
          tx,
          { providerId: queueId },
          { recipient: "dana@example.com", status, at, detail: null, source: "webhook" },
        ),
      )
    const deliveredAt = new Date(Date.now() - 30_000)
    expect(await event("delivered", deliveredAt)).toBe(true)
    const link = await plant(sent, { url: "https://www.example.com/" })
    const base = await listening()
    await fetch(`${base}/l/${link.code}`, { redirect: "manual", headers: { "x-forwarded-for": "192.0.2.30" } })
    // A later spam report replaces the status and its time; the first delivery stays.
    expect(await event("spam", new Date())).toBe(true)
    const [row] = await db().select().from(outboxRecipient).where(eq(outboxRecipient.messageId, sent))
    expect(row).toMatchObject({ delivery: "spam", firstDeliveredAt: deliveredAt })
    // A second delivered event does not move it either.
    await event("delivered", new Date(Date.now() + 1000))
    const [again] = await db().select().from(outboxRecipient).where(eq(outboxRecipient.messageId, sent))
    expect(again?.firstDeliveredAt).toEqual(deliveredAt)

    const view = (await b.call("GET", `/api/v1/tickets/${number}`)).json as TicketView
    expect(view.messages.find((m) => m.id === sent)?.links?.[0]?.clicks).toEqual([
      expect.objectContaining({ ip: "192.0.2.30", scanner: ["early"] }),
    ])
  })
})
