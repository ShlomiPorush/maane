import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PART_STATUSES, REFERENCE_ALPHABET, SEARCH_MAX_LENGTH, STORED_STATUSES, userEmail } from "@maane/shared"
import { parse as parseDisposition } from "content-disposition"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  authUser,
  category,
  intakeConversation,
  intakeRecord,
  intakeSource,
  message,
  messagePart,
  organization,
  storedFile,
  ticket,
  ticketCategory,
  ticketParticipant,
} from "../db/schema.ts"
import { storedFilePath } from "../files/paths.ts"
import { sanitizeMailHtml } from "../mail/html.ts"
import { createTestApp } from "../testing/app.ts"
import { nextIp, TestBrowser, testPassword } from "../testing/browser.ts"
import { createTestDatabase } from "../testing/db.ts"
import { pdf, png } from "../testing/files.ts"
import { Tickets } from "./service.ts"

// The ticket routes of plan 2.4 against a migrated database and a file store in a temporary directory. Tickets,
// messages, parts, and files are written here as intake writes them; the routes only read.

let database: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createTestApp>
let filesDir: string
let sourceId: string
const password = testPassword()

beforeEach(async () => {
  database = await createTestDatabase()
  filesDir = await mkdtemp(join(tmpdir(), "maane-tickets-"))
  app = createTestApp(database, {}, undefined, filesDir)
  await app.ready
  const [source] = await database.db
    .insert(intakeSource)
    .values({ tenantId: `tenant-${randomBytes(4).toString("hex")}`, mailbox: "intake@example.com" })
    .returning({ id: intakeSource.id })
  sourceId = source?.id ?? ""
})
afterEach(async () => {
  await app.close()
  await database.drop()
  await rm(filesDir, { recursive: true, force: true })
})

// Hebrew from code points: the repository holds no literal Hebrew outside he.json.
const SHALOM = String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd)
const browser = () => new TestBrowser(app.fetch, nextIp())
const db = () => database.db

async function firstAdmin() {
  const b = browser()
  expect((await b.setup("first.admin", password)).status).toBe(200)
  await b.enroll(password)
  return b
}

async function newAgent(admin: TestBrowser, name: string) {
  const created = await admin.call("POST", "/api/auth/admin/create-user", {
    email: userEmail(name),
    password,
    name,
    role: "agent",
    data: { username: name },
  })
  expect(created.status, JSON.stringify(created.json)).toBe(200)
  const b = browser()
  expect((await b.passwordSignIn(name, password)).status).toBe(200)
  await b.enroll(password)
  return { b, id: created.json.user.id as string }
}

async function newOrganization(name: string): Promise<string> {
  const [row] = await db().insert(organization).values({ name }).returning({ id: organization.id })
  return row?.id ?? ""
}

const code = () =>
  Array.from(
    { length: 8 },
    (_, i) => (i === 4 ? "-" : "") + REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)],
  ).join("")

async function newTicket(
  organizationId: string,
  values: Partial<typeof ticket.$inferInsert> = {},
): Promise<{ id: string; number: number }> {
  const [row] = await db()
    .insert(ticket)
    .values({ referenceCode: code(), organizationId, supportAddress: "help@example.com", subject: "Hello", ...values })
    .returning({ id: ticket.id, number: ticket.number })
  if (!row) throw new Error("no ticket")
  return row
}

async function newMessage(ticketId: string | null, values: Partial<typeof message.$inferInsert> = {}): Promise<string> {
  const [row] = await db()
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
      fromName: "Dana Customer",
      toAddresses: [{ address: "help@example.com", name: null }],
      subject: "Hello",
      textBody: "Hello",
      ticketId,
      ...values,
    })
    .returning({ id: message.id })
  return row?.id ?? ""
}

/** A file in the store and its row, as FileService writes them. */
async function storeFile(bytes: Buffer, detectedType: string, scanStatus = "clean"): Promise<string> {
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const path = storedFilePath(filesDir, sha256)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  await db()
    .insert(storedFile)
    .values({ sha256, size: bytes.length, detectedType, scanStatus, scannedAt: new Date() })
    .onConflictDoNothing()
  return sha256
}

let partIndex = 0
async function newPart(messageId: string, values: Partial<typeof messagePart.$inferInsert> = {}): Promise<string> {
  const [row] = await db()
    .insert(messagePart)
    .values({
      messageId,
      index: partIndex++,
      kind: "attachment",
      fileName: "file.bin",
      size: 1,
      sha256: randomBytes(32).toString("hex"),
      status: "clean",
      ...values,
    })
    .returning({ id: messagePart.id })
  return row?.id ?? ""
}

/** A clean PNG attachment of a message. */
async function pngPart(messageId: string, values: Partial<typeof messagePart.$inferInsert> = {}) {
  const bytes = png()
  return newPart(messageId, {
    fileName: "image.png",
    size: bytes.length,
    storedSha256: await storeFile(bytes, "image/png"),
    ...values,
  })
}

const BODY_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'"

describe("scope", () => {
  it("scopes every route to the user's organizations, and refuses a removed member at once", async () => {
    const admin = await firstAdmin()
    const agent = await newAgent(admin, "agent.one")
    const lonely = await newAgent(admin, "agent.two")
    const a = await newOrganization("Alpha")
    const b = await newOrganization("Beta")
    expect((await admin.call("POST", `/api/v1/admin/organizations/${a}/members`, { userId: agent.id })).status).toBe(
      201,
    )
    const ticketA = await newTicket(a, { subject: "In Alpha" })
    const ticketB = await newTicket(b, { subject: "In Beta" })
    const messageA = await newMessage(ticketA.id, { htmlBody: "<p>a</p>" })
    const messageB = await newMessage(ticketB.id, { htmlBody: "<p>b</p>" })
    const partA = await pngPart(messageA)
    const partB = await pngPart(messageB)

    const numbers = async (who: TestBrowser) =>
      (await who.call("GET", "/api/v1/tickets")).json.tickets.map((t: { number: number }) => t.number)
    expect(await numbers(admin)).toEqual([ticketB.number, ticketA.number])
    expect(await numbers(agent.b)).toEqual([ticketA.number])
    expect((await agent.b.call("GET", "/api/v1/tickets")).json.organizations).toEqual([{ id: a, name: "Alpha" }])
    // An agent of no organization sees an empty list, not an error.
    expect((await lonely.b.call("GET", "/api/v1/tickets")).json).toEqual({
      tickets: [],
      next: null,
      organizations: [],
      categories: [],
    })
    // Filtering by an organization outside the scope shows nothing of it.
    expect((await agent.b.call("GET", `/api/v1/tickets?organization=${b}`)).json.tickets).toEqual([])

    const routes = (t: number, m: string, p: string) => [
      `/api/v1/tickets/${t}`,
      `/api/v1/messages/${m}/body`,
      `/api/v1/messages/${m}/body?images=1`,
      `/api/v1/files/${p}`,
      `/api/v1/files/${p}/preview`,
    ]
    for (const path of routes(ticketA.number, messageA, partA)) {
      expect((await agent.b.get(path)).status, path).toBe(200)
      expect((await admin.get(path)).status, path).toBe(200)
    }
    for (const path of routes(ticketB.number, messageB, partB)) {
      const answer = await agent.b.get(path)
      expect(answer.status, path).toBe(404)
      expect(await answer.json()).toEqual({ error: "not_found" })
      expect((await lonely.b.get(path)).status, path).toBe(404)
    }

    // Removed from Alpha: the very next request of the same session is refused, on every route.
    expect((await admin.call("DELETE", `/api/v1/admin/organizations/${a}/members/${agent.id}`)).status).toBe(200)
    expect(await numbers(agent.b)).toEqual([])
    for (const path of routes(ticketA.number, messageA, partA)) expect((await agent.b.get(path)).status, path).toBe(404)
    // Signed out: nothing.
    for (const path of routes(ticketA.number, messageA, partA))
      expect((await browser().get(path)).status, path).toBe(401)
  })

  it("answers 404 to a number or an id that names nothing, and to a message without a ticket", async () => {
    const admin = await firstAdmin()
    const a = await newOrganization("Alpha")
    const listening = await newMessage(null, { htmlBody: "<p>x</p>" })
    const part = await pngPart(listening)
    await newTicket(a)
    for (const path of [
      "/api/v1/tickets/abc",
      "/api/v1/tickets/0",
      "/api/v1/tickets/-1",
      "/api/v1/tickets/99999999999999999999",
      "/api/v1/tickets/999999",
      "/api/v1/messages/not-a-uuid/body",
      `/api/v1/messages/${randomBytes(16).toString("hex")}/body`,
      "/api/v1/messages/00000000-0000-4000-8000-000000000000/body",
      `/api/v1/messages/${listening}/body`,
      "/api/v1/files/xyz",
      "/api/v1/files/00000000-0000-4000-8000-000000000000/preview",
      `/api/v1/files/${part}`,
      `/api/v1/files/${part}/preview`,
    ]) {
      expect((await admin.get(path)).status, path).toBe(404)
    }
    expect((await admin.call("GET", "/api/v1/tickets?after=nope")).json).toEqual({ error: "request_invalid" })
    expect((await admin.call("GET", "/api/v1/tickets?organization=nope")).status).toBe(400)
    expect((await admin.call("GET", "/api/v1/tickets?status=archived")).status).toBe(400)
  })
})

describe("files", () => {
  it("previews only a part and a stored file that both scanned clean, and downloads only what is stored", async () => {
    const admin = await firstAdmin()
    const t = await newTicket(await newOrganization("Alpha"))
    const m = await newMessage(t.id)
    const bytes = png()
    for (const status of PART_STATUSES) {
      const stored = (STORED_STATUSES as readonly string[]).includes(status)
      const part = await newPart(m, {
        fileName: `${status}.png`,
        status,
        signature: status === "infected" ? "Eicar-Signature" : null,
        storedSha256: stored ? await storeFile(Buffer.concat([bytes, Buffer.from(status)]), "image/png", status) : null,
      })
      const preview = await admin.get(`/api/v1/files/${part}/preview`)
      const download = await admin.get(`/api/v1/files/${part}`)
      if (status === "clean") {
        expect(preview.status, status).toBe(200)
        expect(preview.headers.get("content-type")).toBe("image/png")
      } else {
        expect(preview.status, status).toBe(stored ? 403 : 404)
        if (stored) expect(await preview.json()).toEqual({ error: "preview_refused" })
      }
      expect(download.status, status).toBe(stored ? 200 : 404)
    }
    // A part that says clean whose stored file does not (a not-scanned file of the same content) is no preview.
    const mixed = await newPart(m, {
      storedSha256: await storeFile(Buffer.from("other content"), "image/png", "not_scanned"),
    })
    expect((await admin.get(`/api/v1/files/${mixed}/preview`)).status).toBe(403)
  })

  it("previews by the type read from the content: never SVG or markup, text always as plain UTF-8", async () => {
    const admin = await firstAdmin()
    const t = await newTicket(await newOrganization("Alpha"))
    const m = await newMessage(t.id)
    const refused = [
      ["image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'><script>x()</script></svg>"],
      ["text/html", "<html><script>x()</script></html>"],
      ["application/xml", "<?xml version='1.0'?><a/>"],
      ["application/octet-stream", "<svg onload=x()>"],
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "PK"],
    ] as const
    for (const [type, content] of refused) {
      const part = await newPart(m, {
        fileName: "drawing.svg",
        declaredType: "image/png",
        storedSha256: await storeFile(Buffer.from(content), type),
      })
      expect((await admin.get(`/api/v1/files/${part}/preview`)).status, type).toBe(403)
      // Downloaded as bytes, never as its own type.
      const download = await admin.get(`/api/v1/files/${part}`)
      expect(download.headers.get("content-type"), type).toBe("application/octet-stream")
    }
    const text = await newPart(m, {
      fileName: "notes.html",
      declaredType: "text/html",
      storedSha256: await storeFile(Buffer.from(`${SHALOM} <b>x</b>`), "text/plain"),
    })
    const shown = await admin.get(`/api/v1/files/${text}/preview`)
    expect(shown.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(await shown.text()).toBe(`${SHALOM} <b>x</b>`)
    const document = await newPart(m, {
      declaredType: "image/png",
      storedSha256: await storeFile(pdf(), "application/pdf"),
    })
    expect((await admin.get(`/api/v1/files/${document}/preview`)).headers.get("content-type")).toBe("application/pdf")
  })

  it("names a download with a safe RFC 6266 file name, Hebrew kept, quotes and line breaks harmless", async () => {
    const admin = await firstAdmin()
    const t = await newTicket(await newOrganization("Alpha"))
    const m = await newMessage(t.id)
    const bytes = png()
    const sha = await storeFile(bytes, "image/png")
    const hebrew = await newPart(m, { fileName: `${SHALOM}.png`, storedSha256: sha })
    const hostile = await newPart(m, {
      fileName: `a"b\r\nX-Injected: 1\\..\\c/d${String.fromCodePoint(0x202e)}gnp.exe`,
      storedSha256: sha,
    })

    const first = await admin.get(`/api/v1/files/${hebrew}`)
    expect(first.status).toBe(200)
    expect(Buffer.from(await first.arrayBuffer()).equals(bytes)).toBe(true)
    const named = parseDisposition(first.headers.get("content-disposition") ?? "")
    expect(named.type).toBe("attachment")
    expect(named.parameters.filename).toBe(`${SHALOM}.png`)

    const second = await admin.get(`/api/v1/files/${hostile}`)
    expect(second.status).toBe(200)
    expect(second.headers.get("x-injected")).toBeNull()
    const header = second.headers.get("content-disposition") ?? ""
    expect(header).not.toMatch(/[\r\n]/)
    const parsed = parseDisposition(header)
    expect(parsed.type).toBe("attachment")
    expect(parsed.parameters.filename).toBe('a"b__X-Injected: 1_.._c_d_gnp.exe')
    expect(second.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox")
    expect(second.headers.get("x-content-type-options")).toBe("nosniff")
    expect(second.headers.get("x-frame-options")).toBe("DENY")
  })
})

describe("caching", () => {
  it("lets no browser or proxy keep any private answer: lists, tickets, bodies, files, the intake log, and refusals", async () => {
    const admin = await firstAdmin()
    const agent = await newAgent(admin, "agent.one")
    const t = await newTicket(await newOrganization("Alpha"))
    const m = await newMessage(t.id, { htmlBody: "<p>hello</p>" })
    const file = await pngPart(m)
    const markup = await newPart(m, { storedSha256: await storeFile(Buffer.from("<svg/>"), "image/svg+xml") })
    const answers: [string, Response, number][] = [
      ["the list", await admin.get("/api/v1/tickets"), 200],
      ["a ticket", await admin.get(`/api/v1/tickets/${t.number}`), 200],
      ["a body", await admin.get(`/api/v1/messages/${m}/body`), 200],
      ["a body with remote images", await admin.get(`/api/v1/messages/${m}/body?images=1`), 200],
      ["a download", await admin.get(`/api/v1/files/${file}`), 200],
      ["a preview", await admin.get(`/api/v1/files/${file}/preview`), 200],
      ["the intake log", await admin.get("/api/v1/intake"), 200],
      ["who is signed in", await admin.get("/api/v1/me"), 200],
      ["a ticket outside the scope", await agent.b.get(`/api/v1/tickets/${t.number}`), 404],
      ["a body outside the scope", await agent.b.get(`/api/v1/messages/${m}/body`), 404],
      ["a file outside the scope", await agent.b.get(`/api/v1/files/${file}`), 404],
      ["a refused preview", await admin.get(`/api/v1/files/${markup}/preview`), 403],
      ["the intake log for an agent", await agent.b.get("/api/v1/intake"), 403],
      ["a bad filter", await admin.get("/api/v1/tickets?status=archived"), 400],
      ["signed out", await browser().get("/api/v1/tickets"), 401],
    ]
    for (const [what, answer, status] of answers) {
      expect(answer.status, what).toBe(status)
      expect(answer.headers.get("cache-control"), what).toBe("private, no-store")
    }
  })
})

describe("file names", () => {
  it("cuts a long name between characters, never inside an emoji, and still serves the file", async () => {
    const admin = await firstAdmin()
    const t = await newTicket(await newOrganization("Alpha"))
    const m = await newMessage(t.id)
    // 199 letters, then an emoji (two UTF-16 units), so the 200th character is the whole emoji.
    const emoji = String.fromCodePoint(0x1f4c4)
    const part = await pngPart(m, { fileName: `${"a".repeat(199)}${emoji}.pdf` })
    const download = await admin.get(`/api/v1/files/${part}`)
    expect(download.status).toBe(200)
    const named = parseDisposition(download.headers.get("content-disposition") ?? "")
    expect(named.parameters.filename).toBe(`${"a".repeat(199)}${emoji}`)
  })
})

describe("message bodies", () => {
  it("sends the body route's own headers, while an ordinary route and every refusal keep the UI's", async () => {
    const admin = await firstAdmin()
    const t = await newTicket(await newOrganization("Alpha"))
    const m = await newMessage(t.id, { htmlBody: "<p>hello</p>" })

    const body = await admin.get(`/api/v1/messages/${m}/body`)
    expect(body.status).toBe(200)
    expect(body.headers.get("content-type")).toBe("text/html; charset=UTF-8")
    expect(body.headers.get("content-security-policy")).toBe(BODY_CSP)
    expect(body.headers.get("x-frame-options")).toBeNull()
    expect(body.headers.get("x-content-type-options")).toBe("nosniff")
    expect(body.headers.get("referrer-policy")).toBe("no-referrer")
    const images = await admin.get(`/api/v1/messages/${m}/body?images=1`)
    expect(images.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; sandbox allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'",
    )

    for (const answer of [
      await admin.get("/api/v1/me"),
      await admin.get("/api/v1/messages/00000000-0000-4000-8000-000000000000/body"),
      await browser().get(`/api/v1/messages/${m}/body`),
    ]) {
      const csp = answer.headers.get("content-security-policy") ?? ""
      expect(csp).toContain("frame-src 'self'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("script-src 'self'")
      expect(answer.headers.get("x-frame-options")).toBe("DENY")
      expect(answer.headers.get("x-content-type-options")).toBe("nosniff")
    }
  })

  it("embeds the message's own clean images, removes the rest, and shows remote images only on request", async () => {
    const admin = await firstAdmin()
    const t = await newTicket(await newOrganization("Alpha"))
    const html = sanitizeMailHtml(
      `<p>${SHALOM}</p><img src="cid:logo@example.com" alt="logo"><img src="cid:bad@example.com">` +
        `<img src="cid:elsewhere@example.com"><img src="cid:declared@example.com"><img src="https://img.example.com/x.png">`,
    )
    const m = await newMessage(t.id, { htmlBody: html, textBody: null })
    const other = await newMessage(t.id)
    const logo = png(8, 8)
    await pngPart(m, {
      kind: "inline",
      contentId: "logo@example.com",
      storedSha256: await storeFile(logo, "image/png"),
    })
    await newPart(m, { kind: "inline", contentId: "bad@example.com", status: "infected", signature: "Eicar-Signature" })
    // An image of another message is never embedded here, nor a part whose content is not an image.
    await pngPart(other, { kind: "inline", contentId: "elsewhere@example.com" })
    await newPart(m, {
      kind: "inline",
      contentId: "declared@example.com",
      declaredType: "image/png",
      storedSha256: await storeFile(Buffer.from("<svg onload=x()>"), "application/octet-stream"),
    })

    const blocked = await (await admin.get(`/api/v1/messages/${m}/body`)).text()
    expect(blocked).toContain('<body dir="rtl">')
    expect(blocked).toContain(`<img alt="logo" src="data:image/png;base64,${logo.toString("base64")}" />`)
    expect(blocked.match(/<img/g)).toHaveLength(1)
    expect(blocked).not.toContain("cid:")
    expect(blocked).not.toContain("img.example.com")
    const shown = await (await admin.get(`/api/v1/messages/${m}/body?images=1`)).text()
    expect(shown).toContain('<img src="https://img.example.com/x.png" />')

    const view = (await admin.call("GET", `/api/v1/tickets/${t.number}`)).json
    expect(view.messages[0]).toMatchObject({ id: m, body: "html", remoteImages: 1 })
  })

  it("sets each paragraph's direction on the server: an image alone in Hebrew mail is right to left (plan 3.2)", async () => {
    const admin = await firstAdmin()
    const t = await newTicket(await newOrganization("Alpha"))
    const html = sanitizeMailHtml(
      `<p>${SHALOM}</p><p><img src="cid:logo@example.com" alt="logo"></p><p dir="auto">An English line.</p>`,
    )
    const m = await newMessage(t.id, { htmlBody: html, textBody: null })
    const logo = png(8, 8)
    await pngPart(m, {
      kind: "inline",
      contentId: "logo@example.com",
      storedSha256: await storeFile(logo, "image/png"),
    })
    const body = await (await admin.get(`/api/v1/messages/${m}/body`)).text()
    expect(body).toContain('<body dir="rtl">')
    expect(body).toContain(`<p dir="rtl">${SHALOM}</p>`)
    expect(body).toContain(`<p dir="rtl"><img alt="logo" src="data:image/png;base64,${logo.toString("base64")}" /></p>`)
    expect(body).toContain('<p dir="ltr">An English line.</p>')
    expect(body).not.toContain('dir="auto"')
    expect(body).not.toContain("unicode-bidi")
    // Stored content is not changed: it is a render pass.
    const [stored] = await db().select({ htmlBody: message.htmlBody }).from(message).where(eq(message.id, m))
    expect(stored?.htmlBody).toBe(html)
  })

  it("serves links that open in a new tab cut off from Maane, and no link of another scheme", async () => {
    const admin = await firstAdmin()
    const t = await newTicket(await newOrganization("Alpha"))
    const html = sanitizeMailHtml(
      '<p><a href="https://www.example.com/pay">pay</a> <a href="tel:+15555550100">call</a> <a href="cid:x@example.com">part</a></p>',
    )
    const m = await newMessage(t.id, { htmlBody: html })
    const body = await admin.get(`/api/v1/messages/${m}/body`)
    expect(body.headers.get("referrer-policy")).toBe("no-referrer")
    const document = await body.text()
    expect(document).toContain(
      '<a href="https://www.example.com/pay" target="_blank" rel="noopener noreferrer">pay</a>',
    )
    expect(document).toContain("<a>call</a>")
    expect(document).toContain("<a>part</a>")
    expect(document).not.toContain("tel:")
    expect(document).not.toContain("cid:")
  })

  it("shows a text-only message escaped and line by line, each line with its direction", async () => {
    const admin = await firstAdmin()
    const t = await newTicket(await newOrganization("Alpha"))
    const m = await newMessage(t.id, { htmlBody: null, textBody: `${SHALOM}\nhello <script>x()</script>` })
    const body = await (await admin.get(`/api/v1/messages/${m}/body`)).text()
    expect(body).toContain(`<div dir="rtl">${SHALOM}</div>`)
    expect(body).toContain('<div dir="ltr">hello &lt;script&gt;x()&lt;/script&gt;</div>')
    expect(body).not.toContain("<script>")
    // Nothing to show: no HTML and no text (both blocked).
    const empty = await newMessage(t.id, { htmlBody: null, textBody: null })
    expect((await admin.get(`/api/v1/messages/${empty}/body`)).status).toBe(404)
  })
})

describe("the ticket view and list", () => {
  it("shows what a scan blocked with its signature, never the content", async () => {
    const admin = await firstAdmin()
    const t = await newTicket(await newOrganization("Alpha"), { subject: "Blocked" })
    await newMessage(t.id, {
      textBody: null,
      htmlBody: "<p>The rest of the message</p>",
      reviewFlags: ["blocked_content"],
      fieldScans: {
        text: { status: "infected", signature: "Eicar-Signature", blockedBy: null },
        html: { status: "clean", signature: null, blockedBy: null },
        headers: { status: "clean", signature: null, blockedBy: null },
      },
    })
    const m = (await db().select({ id: message.id }).from(message))[0]?.id ?? ""
    await newPart(m, { fileName: "invoice.pdf", status: "infected", signature: "Win.Test.EICAR_HDB-1" })
    await newPart(m, { fileName: "run.exe", status: "blocked_type", blockedBy: ".exe" })
    const view = (await admin.call("GET", `/api/v1/tickets/${t.number}`)).json
    const [shown] = view.messages
    expect(shown.fields).toEqual([{ field: "text", status: "infected", signature: "Eicar-Signature" }])
    expect(shown.body).toBe("html")
    expect(shown.attachments).toEqual([
      expect.objectContaining({
        fileName: "invoice.pdf",
        status: "infected",
        signature: "Win.Test.EICAR_HDB-1",
        preview: null,
        download: false,
      }),
      expect.objectContaining({
        fileName: "run.exe",
        status: "blocked_type",
        blockedBy: ".exe",
        preview: null,
        download: false,
      }),
    ])
    expect(JSON.stringify(view)).not.toContain("sha256")
    expect((await admin.call("GET", "/api/v1/tickets")).json.tickets[0].reviewFlags).toEqual(["blocked_content"])
  })

  it("lists open work newest first by default, filters by organization, status, category, and review, and pages by a cursor", async () => {
    const admin = await firstAdmin()
    const a = await newOrganization("Alpha")
    const b = await newOrganization("Beta")
    const at = (minutes: number) => new Date(Date.UTC(2026, 10, 12, 10, minutes))
    const one = await newTicket(a, { lastActivityAt: at(1) })
    const two = await newTicket(a, { lastActivityAt: at(3), status: "open" })
    const three = await newTicket(b, { lastActivityAt: at(2), reviewFlags: ["possibly_automated"] })
    const four = await newTicket(b, { lastActivityAt: at(0) })
    const pending = await newTicket(a, { lastActivityAt: at(4), status: "pending" })
    const onHold = await newTicket(a, { lastActivityAt: at(5), status: "on_hold" })
    const solved = await newTicket(a, { lastActivityAt: at(6), status: "solved" })
    const closed = await newTicket(a, { lastActivityAt: at(7), status: "closed" })
    await newMessage(four.id, { reviewFlags: ["invalid_characters"], fromName: null, fromAddress: "zed@example.com" })
    const [billing] = await db().insert(category).values({ name: "Billing" }).returning({ id: category.id })
    await db()
      .insert(ticketCategory)
      .values([one, pending].map((t) => ({ ticketId: t.id, categoryId: billing?.id ?? "" })))
    const numbers = async (query: string) =>
      (await admin.call("GET", `/api/v1/tickets${query}`)).json.tickets.map((t: { number: number }) => t.number)
    // The default view is open work: new, open, and on hold (plan 4.1).
    expect(await numbers("")).toEqual([onHold.number, two.number, three.number, one.number, four.number])
    expect(await numbers("?status=open_work")).toEqual(await numbers(""))
    expect(await numbers("?status=all")).toEqual([
      closed.number,
      solved.number,
      onHold.number,
      pending.number,
      two.number,
      three.number,
      one.number,
      four.number,
    ])
    expect(await numbers(`?organization=${b}`)).toEqual([three.number, four.number])
    expect(await numbers("?status=open")).toEqual([two.number])
    expect(await numbers("?status=pending")).toEqual([pending.number])
    expect(await numbers("?status=solved")).toEqual([solved.number])
    expect(await numbers("?status=closed")).toEqual([closed.number])
    expect(await numbers("?flagged=1")).toEqual([three.number, four.number])
    expect(await numbers(`?category=${billing?.id}`)).toEqual([one.number])
    expect(await numbers(`?category=${billing?.id}&status=all`)).toEqual([pending.number, one.number])
    expect((await admin.call("GET", "/api/v1/tickets?category=nope")).status).toBe(400)
    expect((await admin.call("GET", "/api/v1/tickets")).json.categories).toEqual([{ id: billing?.id, name: "Billing" }])
    const listed = (await admin.call("GET", "/api/v1/tickets")).json.tickets.at(-1)
    expect(listed).toMatchObject({ customer: { address: "zed@example.com", name: null }, messages: 1 })

    const tickets = new Tickets(db(), filesDir)
    const scope = { all: true } as const
    const pages: number[][] = []
    let cursor: string | undefined
    do {
      const page = await tickets.list(scope, { status: "open_work", cursor, limit: 2 })
      pages.push(page.tickets.map((t) => t.number))
      cursor = page.next ?? undefined
    } while (cursor)
    expect(pages.flat()).toEqual([onHold.number, two.number, three.number, one.number, four.number])
    expect(pages[0]).toHaveLength(2)
  })
})

describe("search (plan 4.4)", () => {
  // Hebrew from code points: a stem of three letters, a longer word that holds it in its middle, and filler.
  const STEM = String.fromCodePoint(0x5d7, 0x5e9, 0x5d1)
  const WORD = String.fromCodePoint(0x5d1, 0x5d7, 0x5e9, 0x5d1, 0x5d5, 0x5e0, 0x5d9, 0x5d5, 0x5ea)
  const LAMED = String.fromCodePoint(0x5dc)

  /** An internal note, as the composer writes it: by an agent, with a submission ID. */
  const note = async (ticketId: string, textBody: string) => {
    const [author] = await db().select({ id: authUser.id }).from(authUser).limit(1)
    return newMessage(ticketId, {
      direction: "note",
      textBody,
      sourceId: null,
      graphId: null,
      folder: null,
      graph: null,
      authorUserId: author?.id ?? "",
      submissionId: randomUUID(),
    })
  }
  const participant = (ticketId: string, address: string, name: string | null) =>
    db().insert(ticketParticipant).values({ ticketId, address, name })
  const found = async (who: TestBrowser, term: string, more = "&status=all") => {
    const answer = await who.call("GET", `/api/v1/tickets?q=${encodeURIComponent(term)}${more}`)
    expect(answer.status, term).toBe(200)
    return answer.json.tickets.map((t: { number: number }) => t.number)
  }

  it("finds a short Hebrew stem inside a longer word deep in a long message, newest first and paged", async () => {
    const admin = await firstAdmin()
    const a = await newOrganization("Alpha")
    const at = (minutes: number) => new Date(Date.UTC(2026, 10, 15, 9, minutes))
    const deep = await newTicket(a, { lastActivityAt: at(1) })
    const other = await newTicket(a, { lastActivityAt: at(2) })
    const newer = await newTicket(a, { lastActivityAt: at(3) })
    const filler = `${SHALOM} `.repeat(6000)
    await newMessage(deep.id, { textBody: `${filler}\n${filler}\n${SHALOM} ${WORD} ${SHALOM}\n${filler}` })
    await newMessage(other.id, { textBody: filler })
    await newMessage(newer.id, { textBody: `${WORD}` })
    expect(filler.length).toBeGreaterThanOrEqual(30_000)
    expect(await found(admin, STEM)).toEqual([newer.number, deep.number])
    expect(await found(admin, ` ${STEM}  `)).toEqual([newer.number, deep.number])
    // One and two characters are below the trigram index and still match by substring.
    expect(await found(admin, LAMED)).toEqual([other.number, deep.number])
    expect(await found(admin, STEM.slice(0, 2))).toEqual([newer.number, deep.number])
    expect(await found(admin, `${STEM}x`)).toEqual([])

    // Paged like the list: the cursor keeps the search.
    const tickets = new Tickets(db(), filesDir)
    const first = await tickets.list({ all: true }, { status: "all", search: STEM, limit: 1 })
    expect(first.tickets.map((t) => t.number)).toEqual([newer.number])
    const second = await tickets.list(
      { all: true },
      { status: "all", search: STEM, limit: 1, cursor: first.next ?? "" },
    )
    expect(second.tickets.map((t) => t.number)).toEqual([deep.number])
    const third = await tickets.list(
      { all: true },
      { status: "all", search: STEM, limit: 1, cursor: second.next ?? "" },
    )
    expect(third.tickets).toEqual([])
  })

  it("finds a ticket by its subject, its customer's address and name, a note's text, and its number", async () => {
    const admin = await firstAdmin()
    const a = await newOrganization("Alpha")
    const printer = await newTicket(a, { subject: "Printer jam on floor three" })
    const plain = await newTicket(a, { subject: "Something else" })
    await participant(printer.id, "dana.levi@example.com", "Dana Levi")
    await participant(plain.id, "ron@example.com", null)
    await note(plain.id, "Called the courier")
    expect(await found(admin, "inter JAM")).toEqual([printer.number])
    expect(await found(admin, "LEVI@EXAMPLE")).toEqual([printer.number])
    expect(await found(admin, "dana lev")).toEqual([printer.number])
    expect(await found(admin, "ron@")).toEqual([plain.number])
    expect(await found(admin, "courier")).toEqual([plain.number])
    expect(await found(admin, String(plain.number))).toEqual([plain.number])
    expect(await found(admin, `#${printer.number}`)).toEqual([printer.number])
    expect(await found(admin, "#999999")).toEqual([])
    expect(await found(admin, "nothing like it")).toEqual([])
  })

  it("matches %, _, and a backslash literally", async () => {
    const admin = await firstAdmin()
    const a = await newOrganization("Alpha")
    const percent = await newTicket(a, { subject: "100% refund" })
    await newTicket(a, { subject: "1000 refunds" })
    const underscore = await newTicket(a, { subject: "file a_b.txt" })
    await newTicket(a, { subject: "file axb.txt" })
    const backslash = await newTicket(a, { subject: "path C:\\temp" })
    await newTicket(a, { subject: "path C:temp" })
    expect(await found(admin, "0% r")).toEqual([percent.number])
    expect(await found(admin, "%")).toEqual([percent.number])
    expect(await found(admin, "a_b")).toEqual([underscore.number])
    expect(await found(admin, "_")).toEqual([underscore.number])
    expect(await found(admin, "C:\\")).toEqual([backslash.number])
    expect(await found(admin, "\\")).toEqual([backslash.number])
  })

  it("never shows an agent another organization's ticket, by any field, and keeps the scope of every filter", async () => {
    const admin = await firstAdmin()
    const agent = await newAgent(admin, "agent.search")
    const a = await newOrganization("Alpha")
    const b = await newOrganization("Beta")
    expect((await admin.call("POST", `/api/v1/admin/organizations/${a}/members`, { userId: agent.id })).status).toBe(
      201,
    )
    const mine = await newTicket(a, { subject: `Order ${WORD}` })
    const theirs = await newTicket(b, { subject: `Order ${WORD}` })
    await participant(mine.id, "same@example.com", "Same Name")
    await participant(theirs.id, "same@example.com", "Same Name")
    await newMessage(theirs.id, { textBody: `secret ${STEM} text` })
    await note(theirs.id, "hidden note")
    for (const term of [STEM, "Order", "same@example.com", "Same Name"]) {
      expect(await found(agent.b, term), term).toEqual([mine.number])
      expect(await found(admin, term), term).toEqual([theirs.number, mine.number])
    }
    for (const term of ["secret", "hidden note", `#${theirs.number}`, String(theirs.number)]) {
      expect(await found(agent.b, term), term).toEqual([])
      expect(await found(admin, term), term).toEqual([theirs.number])
    }
    // The organization filter does not widen the scope, and the answer names only the agent's organizations.
    expect(await found(agent.b, STEM, `&status=all&organization=${b}`)).toEqual([])
    const answer = await agent.b.call("GET", `/api/v1/tickets?q=${encodeURIComponent(STEM)}`)
    expect(answer.json.organizations).toEqual([{ id: a, name: "Alpha" }])
    // Removed from Alpha: the next search finds nothing.
    expect((await admin.call("DELETE", `/api/v1/admin/organizations/${a}/members/${agent.id}`)).status).toBe(200)
    expect(await found(agent.b, STEM)).toEqual([])
  })

  it("combines with the status and category filters, and bounds the term", async () => {
    const admin = await firstAdmin()
    const a = await newOrganization("Alpha")
    const at = (minutes: number) => new Date(Date.UTC(2026, 10, 15, 9, minutes))
    const open = await newTicket(a, { subject: `Invoice ${WORD}`, status: "open", lastActivityAt: at(1) })
    const solved = await newTicket(a, { subject: `Invoice ${WORD}`, status: "solved", lastActivityAt: at(2) })
    await newTicket(a, { subject: "Unrelated", status: "open", lastActivityAt: at(3) })
    const [billing] = await db().insert(category).values({ name: "Billing" }).returning({ id: category.id })
    await db()
      .insert(ticketCategory)
      .values({ ticketId: solved.id, categoryId: billing?.id ?? "" })
    // Without a chosen status a search covers every status, a solved ticket too; a chosen status narrows it.
    expect(await found(admin, STEM, "")).toEqual([solved.number, open.number])
    expect(await found(admin, STEM)).toEqual([solved.number, open.number])
    expect(await found(admin, STEM, "&status=open")).toEqual([open.number])
    expect(await found(admin, STEM, "&status=open_work")).toEqual([open.number])
    expect(await found(admin, STEM, "&status=solved")).toEqual([solved.number])
    expect(await found(admin, STEM, "&status=pending")).toEqual([])
    expect(await found(admin, STEM, `&status=all&category=${billing?.id}`)).toEqual([solved.number])
    // An empty or blank term is no search.
    expect((await found(admin, "   ")).length).toBe(3)
    expect((await found(admin, "   ", "")).length).toBe(2)
    expect((await admin.call("GET", `/api/v1/tickets?q=${"x".repeat(SEARCH_MAX_LENGTH)}`)).status).toBe(200)
    expect((await admin.call("GET", `/api/v1/tickets?q=${"x".repeat(SEARCH_MAX_LENGTH + 1)}`)).status).toBe(400)
    // A NUL, which PostgreSQL refuses in a parameter, is searched as U+FFFD, not an error.
    expect(await found(admin, `a${String.fromCharCode(0)}b`)).toEqual([])
  })

  it("finds a snoozed ticket with no status chosen, which the default view without a term still hides (plan 4.2)", async () => {
    const admin = await firstAdmin()
    const a = await newOrganization("Alpha")
    const at = (minutes: number) => new Date(Date.UTC(2026, 10, 15, 9, minutes))
    const awake = await newTicket(a, { subject: `Invoice ${WORD}`, status: "open", lastActivityAt: at(1) })
    // A snooze is its time still ahead on the ticket row, which the list compares with now().
    const snoozed = await newTicket(a, {
      subject: `Invoice ${WORD}`,
      status: "open",
      lastActivityAt: at(2),
      snoozedUntil: new Date(Date.now() + 2 * 3_600_000),
    })
    const listed = async (query: string) => {
      const answer = await admin.call("GET", `/api/v1/tickets${query}`)
      expect(answer.status, query).toBe(200)
      return answer.json.tickets.map((t: { number: number }) => t.number)
    }
    // Without a term the default view (open work) leaves the snoozed ticket out; the Snoozed filter shows it.
    expect(await listed("")).toEqual([awake.number])
    expect(await listed("?status=snoozed")).toEqual([snoozed.number])
    // A search with no status chosen covers every status, the snoozed ticket too.
    expect(await found(admin, STEM, "")).toEqual([snoozed.number, awake.number])
    // The Snoozed filter and a chosen open work combine with the search.
    expect(await found(admin, STEM, "&status=snoozed")).toEqual([snoozed.number])
    expect(await found(admin, STEM, "&status=open_work")).toEqual([awake.number])
    expect(await found(admin, "nothing like it", "&status=snoozed")).toEqual([])
  })

  it("lets PostgreSQL use the trigram index for the message text, Hebrew included", async () => {
    const a = await newOrganization("Alpha")
    const t = await newTicket(a)
    await newMessage(t.id, { textBody: `${SHALOM} ${WORD}` })
    // An organization with some history, so that reading every ticket of the scope and then its messages is not the
    // cheaper plan; VACUUM ANALYZE takes the statistics and merges GIN's pending entries, as autovacuum would.
    const many = await db()
      .insert(ticket)
      .values(
        Array.from({ length: 2000 }, () => ({
          referenceCode: code(),
          organizationId: a,
          supportAddress: "help@example.com",
          subject: "Hello",
        })),
      )
      .returning({ id: ticket.id })
    await db()
      .insert(message)
      .values(
        many.map((row) => ({
          sourceId,
          graphId: randomBytes(8).toString("hex"),
          folder: "inbox",
          receivedAt: new Date(),
          state: "processed",
          content: "parsed",
          graph: { subject: "Hello" },
          fromAddress: "dana@example.com",
          fromName: "Dana Customer",
          toAddresses: [{ address: "help@example.com", name: null }],
          subject: "Hello",
          textBody: "Hello",
          ticketId: row.id,
        })),
      )
    await db()
      .insert(ticketParticipant)
      .values(many.map((row, i) => ({ ticketId: row.id, address: `customer${i}@example.com`, name: `Customer ${i}` })))
    const client = await database.pool.connect()
    try {
      await client.query("vacuum analyze ticket, message, ticket_participant")
      // Hebrew letters are word characters in this database's locale, so a Hebrew term gives trigrams to look up.
      const trigrams = await client.query("select show_trgm($1) as t", [STEM])
      expect(trigrams.rows[0].t.length).toBeGreaterThan(0)
      // The whole list query as the service runs it, for an admin and for an agent of one organization (the scope in
      // each branch), with a status and a cursor; sequential scans are switched off to ask whether the index is usable.
      const tickets = new Tickets(db(), filesDir)
      const cursor = Buffer.from(JSON.stringify(["2999-01-01T00:00:00.000000Z", 1])).toString("base64url")
      const scopes = [{ all: true as const }, { all: false as const, organizationIds: [a] }]
      for (const scope of scopes) {
        const query = tickets.listQuery(scope, { status: "all", search: STEM, cursor, limit: 50 }).toSQL()
        expect(query.sql).toContain("union all")
        await client.query("begin")
        await client.query("set local enable_seqscan = off")
        const plan = await client.query(`explain (costs off) ${query.sql}`, query.params)
        await client.query("rollback")
        const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n")
        expect(text, JSON.stringify(scope)).toContain("message_text_trgm_idx")
        expect(text, JSON.stringify(scope)).toContain("ticket_subject_trgm_idx")
        expect(text, JSON.stringify(scope)).toContain("ticket_participant_address_trgm_idx")
      }
    } finally {
      client.release()
    }
  })
})

describe("the intake log", () => {
  it("is for admins: records of both modes, filtered by mode and by review", async () => {
    const admin = await firstAdmin()
    const agent = await newAgent(admin, "agent.one")
    const a = await newOrganization("Alpha")
    const t = await newTicket(a)
    const live = await newMessage(t.id, { subject: "Live one" })
    const [conversation] = await db()
      .insert(intakeConversation)
      .values({ organizationId: a, supportAddress: "help@example.com", reviewFlags: ["sender_not_participant"] })
      .returning({ id: intakeConversation.id })
    const listening = await newMessage(null, { subject: "Heard one" })
    const unreadable = await newMessage(null, {
      content: "unavailable",
      subject: null,
      fromAddress: null,
      fromName: null,
      graph: { subject: "From Graph", from: { address: "Someone@Example.com", name: "Someone" } },
      reviewFlags: ["unavailable"],
    })
    await db()
      .insert(intakeRecord)
      .values([
        {
          messageId: live,
          mode: "live",
          outcome: "new_ticket",
          organizationId: a,
          ticketId: t.id,
          supportAddress: "help@example.com",
          createdAt: new Date(Date.UTC(2026, 10, 12, 10, 0)),
        },
        {
          messageId: listening,
          mode: "listening",
          outcome: "new_linked_ticket",
          organizationId: a,
          conversationId: conversation?.id,
          matchedTicketId: t.id,
          reason: "sender_not_participant",
          createdAt: new Date(Date.UTC(2026, 10, 12, 10, 1)),
        },
        {
          messageId: unreadable,
          mode: "listening",
          outcome: "unreadable",
          reason: "unavailable",
          createdAt: new Date(Date.UTC(2026, 10, 12, 10, 2)),
        },
      ])

    expect((await agent.b.call("GET", "/api/v1/intake")).json).toEqual({ error: "forbidden" })
    const all = (await admin.call("GET", "/api/v1/intake")).json
    expect(all.entries.map((e: { messageId: string }) => e.messageId)).toEqual([unreadable, listening, live])
    expect(all.entries[0]).toMatchObject({
      outcome: "unreadable",
      subject: "From Graph",
      from: { address: "someone@example.com", name: "Someone" },
      flags: ["unavailable"],
      organization: null,
    })
    expect(all.entries[1]).toMatchObject({
      mode: "listening",
      matchedTicket: t.number,
      ticket: null,
      reasons: ["sender_not_participant"],
      flags: ["sender_not_participant"],
      organization: { id: a, name: "Alpha" },
    })
    expect(all.entries[2]).toMatchObject({ mode: "live", ticket: t.number, flags: [], reasons: [] })
    const listeningOnly = (await admin.call("GET", "/api/v1/intake?mode=listening")).json.entries
    expect(listeningOnly).toHaveLength(2)
    const flagged = (await admin.call("GET", "/api/v1/intake?flagged=1")).json.entries
    expect(flagged.map((e: { messageId: string }) => e.messageId)).toEqual([unreadable, listening])
    expect((await admin.call("GET", "/api/v1/intake?mode=other")).status).toBe(400)

    const tickets = new Tickets(db(), filesDir)
    const first = await tickets.intake({ limit: 2 })
    const second = await tickets.intake({ limit: 2, cursor: first.next ?? undefined })
    expect([...first.entries, ...second.entries].map((e) => e.messageId)).toEqual([unreadable, listening, live])
    expect(second.next).toBeNull()
  })
})
