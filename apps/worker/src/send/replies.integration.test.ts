import { randomUUID } from "node:crypto"
import { SYSTEM } from "@maane/server/audit"
import {
  auditLog,
  message,
  messagePart,
  outbox,
  outboxRecipient,
  setting,
  storedFile,
  supportAddress,
  ticket as ticketTable,
  upload,
} from "@maane/server/db/schema"
import { refreshDeliveryFlag } from "@maane/server/delivery/service"
import { type JobQueue, openJobQueue, SEND_REPLY, UPLOAD_SCAN } from "@maane/server/jobs/queue"
import { Organizations } from "@maane/server/organizations/service"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { createTestApp } from "@maane/server/testing/app"
import { nextIp, TestBrowser, testPassword } from "@maane/server/testing/browser"
import { pdf, png } from "@maane/server/testing/files"
import { MESSAGE_MAX_BYTES, MESSAGES, type SettingKey, type TicketView, userEmail } from "@maane/shared"
import { and, eq, inArray, sql } from "drizzle-orm"
import { simpleParser } from "mailparser"
import { PgBoss } from "pg-boss"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { eicar } from "../files/samples.ts"
import { referenceCodesIn, ticketNumbersIn } from "../intake/threading.ts"
import { type StandInClamd, startStandInClamd } from "../testing/clamd.ts"
import { type IntakeHarness, startIntake } from "../testing/intake.ts"
import { fromCodePoints, mime } from "../testing/mime.ts"
import { type StandInSmtp, startStandInSmtp } from "../testing/smtp.ts"
import { ReplySender } from "./sender.ts"
import type { SmtpTimeouts } from "./smtp.ts"
import { smtpTest } from "./test.ts"
import { scanUpload } from "./uploads.ts"

const QUICK: SmtpTimeouts = { connection: 2000, greeting: 1500, socket: 3000, setup: 4000, send: 5000 }
const SUPPORT = "support@example.com"
const OTHER = "billing@example.com"
const BOUNCE = "bounce@example.com"
const SHALOM = fromCodePoints(0x5e9, 0x5dc, 0x5d5, 0x5dd)
const TODA = fromCodePoints(0x5ea, 0x5d5, 0x5d3, 0x5d4)

let clamd: StandInClamd
let smtp2go: StandInSmtp
let failover: StandInSmtp
let h: IntakeHarness
let app: ReturnType<typeof createTestApp>
let queue: JobQueue
let boss: PgBoss
let org: string
let otherOrg: string
const password = testPassword()

beforeAll(async () => {
  clamd = await startStandInClamd()
  smtp2go = await startStandInSmtp()
  failover = await startStandInSmtp({ secure: true, acceptAll: true })
})
afterAll(async () => {
  await clamd.close()
  await smtp2go.close()
  await failover.close()
})
beforeEach(async () => {
  h = await startIntake(clamd)
  org = await h.organization("Example Support", [{ value: SUPPORT, isDefault: true }])
  otherOrg = await h.organization("Example Other", [{ value: OTHER }])
  queue = await openJobQueue(h.database.url)
  app = createTestApp(h.database, {}, queue, h.dir)
  await app.ready
  boss = new PgBoss({ connectionString: h.database.url, schema: "pgboss", supervise: false, schedule: false })
  await boss.start()
})
afterEach(async () => {
  await boss.stop({ graceful: false })
  await queue.stop()
  await app.close()
  await h.close()
})

function workerSettings(values: Partial<Record<SettingKey, string>> = {}) {
  return new Settings(h.database.db, createSettingsCipher([{ version: 1, value: h.cipherKey }]), {
    "smtp2go.host": smtp2go.host,
    "smtp2go.port": String(smtp2go.port),
    "smtp2go.user": smtp2go.user,
    "smtp2go.password": smtp2go.password,
    "failover.host": failover.host,
    "failover.port": String(failover.port),
    "failover.security": "tls",
    "failover.user": failover.user,
    "failover.password": failover.password,
    "mail.bounceAddress": BOUNCE,
    ...values,
  })
}

function sender(values: Partial<Record<SettingKey, string>> = {}, options: { afterClaim?: () => Promise<void> } = {}) {
  const settings = workerSettings(values)
  return new ReplySender({
    db: h.database.db,
    settings,
    queue: (jobs, name, data, startAfter) => queue.sendIn(jobs, name, data, { startAfter }),
    timeouts: QUICK,
    afterClaim: options.afterClaim,
  })
}

const browser = () => new TestBrowser(app.fetch, nextIp())

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
  expect(created.status).toBe(200)
  const b = browser()
  expect((await b.passwordSignIn(name, password)).status).toBe(200)
  await b.enroll(password)
  return { b, id: created.json.user.id as string }
}

async function customerTicket(subject = "A question", messageId = `${randomUUID()}@mail.example.com`) {
  const graphId = h.graph.add(
    mime({ messageId, subject, from: "Dana Customer <dana@example.com>", to: SUPPORT, text: { content: SHALOM } }),
  )
  await h.round()
  const found = await h.ticketOf(graphId)
  if (!found) throw new Error("no ticket")
  return { number: found.number, referenceCode: found.referenceCode, messageId }
}

async function uploadFile(b: TestBrowser, name: string, bytes: Buffer): Promise<{ status: number; json: any }> {
  const form = new FormData()
  form.set("file", new File([new Uint8Array(bytes)], name, { type: "application/octet-stream" }))
  const response = await app.fetch(
    new Request(`${b.origin}/api/v1/uploads`, {
      method: "POST",
      body: form,
      headers: {
        "x-forwarded-for": b.ip,
        origin: b.origin,
        "x-maane-request": "1",
        cookie: [...b.cookies].map(([n, v]) => `${n}=${v}`).join("; "),
      },
    }),
  )
  return { status: response.status, json: await response.json() }
}

async function scanned(b: TestBrowser, name: string, bytes: Buffer): Promise<string> {
  const uploaded = await uploadFile(b, name, bytes)
  expect(uploaded.status).toBe(202)
  expect(await scanUpload(h.database.db, h.files, uploaded.json.id)).toBe("clean")
  return uploaded.json.id
}

const reply = (values: Record<string, unknown> = {}) => ({
  submissionId: randomUUID(),
  kind: "reply",
  from: SUPPORT,
  to: [{ address: "dana@example.com", name: "Dana Customer" }],
  cc: [],
  html: `<p dir="auto">${TODA}</p>`,
  uploads: [],
  parts: [],
  ...values,
})

async function view(b: TestBrowser, number: number): Promise<TicketView> {
  const answer = await b.call("GET", `/api/v1/tickets/${number}`)
  expect(answer.status).toBe(200)
  return answer.json
}

const deliveryOf = (v: TicketView, id: string) => v.messages.find((m) => m.id === id)?.delivery

async function someoneWaits(): Promise<boolean> {
  for (let tries = 0; tries < 200; tries++) {
    const result = await h.database.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    )
    if ((result.rows[0]?.n ?? 0) > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

describe("a reply, end to end", () => {
  it("sends a Hebrew reply with an English paragraph and an attachment through SMTP2GO, and it is accepted", async () => {
    const admin = await firstAdmin()
    const ticket = await customerTicket()
    const before = await view(admin, ticket.number)
    expect(before.compose).toMatchObject({
      from: [SUPPORT],
      defaultFrom: SUPPORT,
      to: [{ address: "dana@example.com", name: "Dana Customer" }],
      cc: [],
      senderName: "first.admin (Example Support)",
    })
    expect(before.compose).not.toHaveProperty("listening")
    const file = await scanned(admin, "notes.txt", Buffer.from("The notes of the meeting.\n"))
    const html = `<p dir="auto">${SHALOM}, ${TODA}</p><p dir="auto">The English paragraph.</p>`
    const written = await admin.call(
      "POST",
      `/api/v1/tickets/${ticket.number}/messages`,
      reply({ html, uploads: [file] }),
    )
    expect(written.status, JSON.stringify(written.json)).toBe(201)
    const id = written.json.id as string

    const [job] = await boss.fetch<{ messageId: string }>(SEND_REPLY)
    expect(job?.data.messageId).toBe(id)
    expect(await sender().send(id)).toBe("accepted")

    const sent = smtp2go.received.at(-1)
    if (!sent) throw new Error("nothing reached the stand-in")
    expect(sent.to).toEqual(["dana@example.com"])
    expect(sent.from).toBe(SUPPORT)
    const parsed = await simpleParser(sent.raw)
    expect(parsed.subject).toBe(`Re: A question [#${ticket.number}]`)
    expect(parsed.inReplyTo).toBe(`<${ticket.messageId}>`)
    expect(parsed.from?.value).toEqual([{ address: SUPPORT, name: "first.admin (Example Support)" }])
    const [header, reference] = (parsed.text ?? "").split(/\r?\n/)
    expect(header).toBe(MESSAGES.he.mail.header)
    expect(reference).toBe(
      `${MESSAGES.he.mail.reference}: ${fromCodePoints(0x2066)}${ticket.referenceCode}${fromCodePoints(0x2069)}`,
    )
    expect(parsed.text).toContain(`${SHALOM}, ${TODA}`)
    expect(parsed.text).toContain("The English paragraph.")
    expect(parsed.html).toContain(`<span dir="ltr">${ticket.referenceCode}</span>`)
    expect(parsed.html).toContain(`<p dir="rtl">${SHALOM}, ${TODA}</p>`)
    expect(parsed.html).toContain('<p dir="ltr">The English paragraph.</p>')
    expect(parsed.html).not.toContain('dir="auto"')
    expect(parsed.html).toMatch(/<html dir="rtl" lang="he">/)
    expect(parsed.attachments.map((a) => [a.filename, a.content.toString()])).toEqual([
      ["notes.txt", "The notes of the meeting.\n"],
    ])
    expect(referenceCodesIn(parsed.text ?? "")).toContain(ticket.referenceCode)
    expect(ticketNumbersIn(parsed.subject ?? "")).toEqual([ticket.number])

    const after = await view(admin, ticket.number)
    const out = after.messages.find((m) => m.id === id)
    expect(out).toMatchObject({
      direction: "out",
      author: { name: "first.admin" },
      from: { address: SUPPORT },
      delivery: {
        state: "accepted",
        problem: null,
        recipients: [{ address: "dana@example.com", kind: "to", state: "accepted", provider: "smtp2go" }],
      },
    })
    expect(out?.attachments.map((a) => a.fileName)).toEqual(["notes.txt"])
    expect(after.ticket.status).toBe("new")
    const [recipient] = await h.database.db.select().from(outboxRecipient).where(eq(outboxRecipient.messageId, id))
    expect(recipient?.response).toContain(`OK id=${sent.queueId}`)
  })

  it("quotes the ticket's public history in the layout: newest first, never a note or a reply nobody accepted", async () => {
    const admin = await firstAdmin()
    const graphId = h.graph.add(
      mime({
        messageId: `${randomUUID()}@mail.example.com`,
        subject: "A screenshot",
        from: "Dana Customer <dana@example.com>",
        to: SUPPORT,
        html: {
          content: `<p>${SHALOM}</p><p><img src="cid:shot%40mail.example.com" alt="shot"></p><p><img src="cid:big@mail.example.com"></p>`,
        },
        attachments: [
          {
            fileName: "shot.png",
            contentType: "image/png",
            content: png(2400, 600),
            inline: true,
            contentId: "shot@mail.example.com",
          },
          {
            fileName: "big.png",
            contentType: "image/png",
            content: png(64, 64, [200, 40, 40]),
            inline: true,
            contentId: "big@mail.example.com",
          },
          { fileName: "invoice.pdf", contentType: "application/pdf", content: pdf() },
        ],
      }),
    )
    await h.round()
    const found = await h.ticketOf(graphId)
    if (!found) throw new Error("no ticket")
    const [big] = await h.database.db
      .select({ sha256: messagePart.storedSha256 })
      .from(messagePart)
      .where(eq(messagePart.contentId, "big@mail.example.com"))
    await h.database.db
      .update(storedFile)
      .set({ size: 6 * 1024 * 1024 })
      .where(eq(storedFile.sha256, big?.sha256 ?? ""))
    const post = async (values: Record<string, unknown>) => {
      const written = await admin.call("POST", `/api/v1/tickets/${found.number}/messages`, reply(values))
      expect(written.status, JSON.stringify(written.json)).toBe(201)
      return written.json.id as string
    }
    await post({ kind: "note", html: "<p>An internal note for the team.</p>" })
    const refused = await post({
      to: [{ address: "refuse.nobody@example.com", name: null }],
      html: "<p>Nobody got this.</p>",
    })
    expect(await sender({ "failover.host": "" }).send(refused)).toBe("failed")
    expect(await sender().send(await post({ html: "<p>The first answer.</p>" }))).toBe("accepted")
    expect(await sender().send(await post({ html: `<p dir="auto">${TODA}</p>` }))).toBe("accepted")

    const sent = smtp2go.received.at(-1)
    if (!sent) throw new Error("nothing reached the stand-in")
    const parsed = await simpleParser(sent.raw, { skipImageLinks: true })
    const html = parsed.html || ""
    const quote = html.indexOf('<blockquote type="cite"')
    expect(html.indexOf(found.referenceCode)).toBeLessThan(html.indexOf('class="email-avatar"'))
    expect(html.indexOf(`<p dir="rtl">${TODA}</p>`)).toBeLessThan(quote)
    expect(html.indexOf("The first answer.")).toBeGreaterThan(quote)
    expect(html.indexOf(`<p dir="rtl">${SHALOM}</p>`)).toBeGreaterThan(html.indexOf("The first answer."))
    expect(html).not.toContain("An internal note")
    expect(html).not.toContain("Nobody got this.")
    expect(html).not.toContain('dir="auto"')
    expect(html).toContain('<span dir="ltr">invoice.pdf</span>')
    expect(html).toContain("<span>[big.png]</span>")
    const image =
      /<p dir="rtl"><img alt="shot" src="cid:([^"]+)" width="586" height="147" style="width:586px;max-width:100%;height:auto;border:0" \/><\/p>/.exec(
        html,
      )
    expect(image, html).not.toBeNull()
    const embedded = parsed.attachments.find((file) => file.cid === image?.[1])
    expect(embedded).toMatchObject({ contentType: "image/png", contentDisposition: "inline" })
    expect(parsed.attachments.map((file) => file.filename)).toEqual(["shot.png"])
    const text = parsed.text ?? ""
    expect(text).toContain("> first.admin (Example Support) | ")
    expect(text).toContain("> The first answer.")
    expect(text).not.toContain("internal note")
  })

  it("carries tracked links and history download links that lead back through Maane (plan 3.4)", async () => {
    const admin = await firstAdmin()
    const graphId = h.graph.add(
      mime({
        messageId: `${randomUUID()}@mail.example.com`,
        subject: "An invoice",
        from: "Dana Customer <dana@example.com>",
        to: SUPPORT,
        text: { content: "See the invoice." },
        attachments: [{ fileName: "invoice.pdf", contentType: "application/pdf", content: pdf() }],
      }),
    )
    await h.round()
    const found = await h.ticketOf(graphId)
    if (!found) throw new Error("no ticket")
    const html =
      '<p dir="auto">Read <a href="https://www.example.com/guide">the guide</a> or <a href="mailto:help@example.com">mail us</a>.</p>'
    const written = await admin.call("POST", `/api/v1/tickets/${found.number}/messages`, reply({ html }))
    expect(written.status, JSON.stringify(written.json)).toBe(201)
    expect(await sender().send(written.json.id)).toBe("accepted")
    const sent = smtp2go.received.at(-1)
    if (!sent) throw new Error("nothing reached the stand-in")
    const parsed = await simpleParser(sent.raw)
    const out = parsed.html || ""
    const tracked = /<a href="(http:\/\/127\.0\.0\.1:8090\/l\/[A-Za-z0-9_-]{22})"[^>]*>the guide<\/a>/.exec(out)
    const download =
      /<a href="(http:\/\/127\.0\.0\.1:8090\/f\/[A-Za-z0-9_-]{22})"[^>]*><span dir="ltr">invoice\.pdf<\/span><\/a>/.exec(
        out,
      )
    expect(tracked, out).not.toBeNull()
    expect(download, out).not.toBeNull()
    expect(out).toContain('href="mailto:help@example.com"')
    expect(out).not.toContain("https://www.example.com/guide")
    expect(parsed.text).toContain("https://www.example.com/guide")
    expect(parsed.text).not.toContain("127.0.0.1:8090/")

    const redirect = await app.fetch(new Request(tracked?.[1] ?? ""))
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get("location")).toBe("https://www.example.com/guide")
    const file = await app.fetch(new Request(download?.[1] ?? ""))
    expect(file.status).toBe(200)
    expect(file.headers.get("content-disposition")).toContain("attachment")
    expect(Buffer.from(await file.arrayBuffer())).toEqual(pdf())

    const after = await view(admin, found.number)
    expect(after.messages.find((m) => m.id === written.json.id)?.links).toEqual([
      {
        id: expect.any(String),
        kind: "url",
        target: "https://www.example.com/guide",
        total: 1,
        clicks: [expect.objectContaining({ ip: null })],
      },
      {
        id: expect.any(String),
        kind: "file",
        target: "invoice.pdf",
        total: 1,
        clicks: [expect.objectContaining({ ip: null })],
      },
    ])

    const settings = await admin.call("PUT", "/api/v1/settings", {
      "links.tracking": "off",
      "links.domain": "links.example.com",
    })
    expect(settings.status).toBe(200)
    const again = await admin.call("POST", `/api/v1/tickets/${found.number}/messages`, reply({ html }))
    expect(await sender().send(again.json.id)).toBe("accepted")
    const second = (await simpleParser(smtp2go.received.at(-1)?.raw ?? Buffer.alloc(0))).html || ""
    expect(second).toContain('<a href="https://www.example.com/guide"')
    expect(second).not.toMatch(/\/l\/[A-Za-z0-9_-]{22}/)
    expect(second).toMatch(/<a href="https:\/\/links\.example\.com\/f\/[A-Za-z0-9_-]{22}"/)
  })

  it("refuses a reply whose own files are larger than the provider takes, before anything is written", async () => {
    const admin = await firstAdmin()
    const graphId = h.graph.add(
      mime({
        subject: "A large file",
        text: { content: "See the file." },
        attachments: [{ fileName: "video.bin", contentType: "application/octet-stream", content: Buffer.from("x") }],
      }),
    )
    await h.round()
    const found = await h.ticketOf(graphId)
    if (!found) throw new Error("no ticket")
    const part = (await view(admin, found.number)).messages[0]?.attachments[0]
    if (!part) throw new Error("no part")
    await h.database.db.update(storedFile).set({ size: MESSAGE_MAX_BYTES })
    const before = (await h.database.db.select({ id: message.id }).from(message)).length
    const answer = await admin.call("POST", `/api/v1/tickets/${found.number}/messages`, reply({ parts: [part.id] }))
    expect(answer.status).toBe(400)
    expect(answer.json).toEqual({ error: "message_too_large", max: MESSAGE_MAX_BYTES })
    expect((await h.database.db.select({ id: message.id }).from(message)).length).toBe(before)
    expect(await boss.fetch(SEND_REPLY)).toEqual([])
  })

  it("writes one message for one click, however often the request is repeated", async () => {
    const admin = await firstAdmin()
    const ticket = await customerTicket()
    const body = reply()
    const answers = await Promise.all(
      [1, 2, 3].map(() => admin.call("POST", `/api/v1/tickets/${ticket.number}/messages`, body)),
    )
    const ids = new Set(answers.map((answer) => answer.json.id))
    expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201])
    expect(ids.size).toBe(1)
    expect(await h.database.db.select().from(outbox)).toHaveLength(1)
    expect(await boss.fetch(SEND_REPLY, { batchSize: 5 })).toHaveLength(1)
  })
})

describe("what a reply may carry and come from", () => {
  it("attaches only the ticket's own files and the user's own uploads", async () => {
    const admin = await firstAdmin()
    const { b: agent, id } = await newAgent(admin, "an.agent")
    await new Organizations(h.database.db).addMember(org, id, { actor: SYSTEM, ipAddress: null })
    const ticket = await customerTicket()
    const other = await customerTicket("Another question")
    const mine = await scanned(admin, "mine.txt", Buffer.from("mine"))
    const theirs = await scanned(agent, "theirs.txt", Buffer.from("theirs"))
    const post = (b: TestBrowser, values: Record<string, unknown>) =>
      b.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply(values))
    expect((await post(admin, { uploads: [theirs] })).json).toEqual({ error: "attachment_invalid" })
    expect((await post(agent, { uploads: [mine] })).json).toEqual({ error: "attachment_invalid" })
    const otherNote = await admin.call(
      "POST",
      `/api/v1/tickets/${other.number}/messages`,
      reply({ kind: "note", uploads: [mine] }),
    )
    const otherPart = (await view(admin, other.number)).messages.find((m) => m.id === otherNote.json.id)?.attachments[0]
      ?.id
    expect(otherPart).toBeTruthy()
    expect((await post(admin, { parts: [otherPart] })).json).toEqual({ error: "attachment_invalid" })
    const pending = await uploadFile(admin, "late.txt", Buffer.from("late"))
    expect((await post(admin, { uploads: [pending.json.id] })).json).toEqual({ error: "attachment_invalid" })
    const ownNote = await admin.call(
      "POST",
      `/api/v1/tickets/${ticket.number}/messages`,
      reply({ kind: "note", uploads: [mine] }),
    )
    const notePart = (await view(admin, ticket.number)).messages.find((m) => m.id === ownNote.json.id)?.attachments[0]
      ?.id
    expect(notePart).toBeTruthy()
    expect((await post(admin, { parts: [notePart] })).json).toEqual({ error: "attachment_invalid" })
    const firstReply = await post(admin, { uploads: [mine] })
    expect(firstReply.status).toBe(201)
    const replyPart = (await view(admin, ticket.number)).messages.find((m) => m.id === firstReply.json.id)
      ?.attachments[0]?.id
    expect((await post(admin, { uploads: [mine], parts: [replyPart] })).status).toBe(201)
    expect((await agent.call("GET", `/api/v1/uploads/${mine}`)).status).toBe(404)
    expect((await admin.call("GET", `/api/v1/uploads/${mine}`)).json).toMatchObject({ status: "clean" })
  })

  it("refuses a From address outside the ticket's organization, when written and when sent", async () => {
    const admin = await firstAdmin()
    const ticket = await customerTicket()
    const post = (values: Record<string, unknown>) =>
      admin.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply(values))
    expect((await post({ from: OTHER })).json).toEqual({ error: "from_not_allowed" })
    expect((await post({ from: "someone@example.com" })).json).toEqual({ error: "from_not_allowed" })
    expect((await post({ from: null })).json).toEqual({ error: "from_not_allowed" })
    expect((await post({ to: [] })).json).toEqual({ error: "recipients_required" })
    expect((await post({ to: [{ address: "not an address", name: null }] })).status).toBe(400)
    const extra = "help@example.com"
    await h.database.db.insert(supportAddress).values({ organizationId: org, kind: "exact", value: extra })
    const written = await post({ from: extra })
    expect(written.status).toBe(201)
    await h.database.db.delete(supportAddress).where(eq(supportAddress.value, extra))
    const received = smtp2go.received.length + failover.received.length
    expect(await sender().send(written.json.id)).toBe("failed")
    expect(deliveryOf(await view(admin, ticket.number), written.json.id)).toMatchObject({
      state: "failed",
      problem: "from_not_allowed",
    })
    expect(smtp2go.received.length + failover.received.length).toBe(received)
  })

  it("has no listening refusal: with no intake mode at all, the send point sends, and the mode setting is gone (phase 6)", async () => {
    const admin = await firstAdmin()
    const ticket = await customerTicket()
    expect(await h.database.db.select().from(setting).where(eq(setting.key, "intake.mode"))).toEqual([])
    const written = await admin.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply())
    expect(written.status).toBe(201)
    const note = await admin.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply({ kind: "note" }))
    expect(note.status).toBe(201)
    const received = smtp2go.received.length
    expect(await sender().send(written.json.id)).toBe("accepted")
    const v = await view(admin, ticket.number)
    expect(deliveryOf(v, written.json.id)).toMatchObject({ problem: null })
    expect(v.messages.find((m) => m.id === note.json.id)).toMatchObject({ direction: "note", delivery: null })
    expect(smtp2go.received.length).toBe(received + 1)
  })

  it("refuses a reply whose author may no longer answer the ticket when it is sent", async () => {
    const admin = await firstAdmin()
    const { b: agent, id } = await newAgent(admin, "an.agent")
    const organizations = new Organizations(h.database.db)
    await organizations.addMember(org, id, { actor: SYSTEM, ipAddress: null })
    const ticket = await customerTicket()
    const written = await agent.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply())
    expect(written.status).toBe(201)
    await organizations.removeMember(org, id, { actor: SYSTEM, ipAddress: null })
    expect(await sender().send(written.json.id)).toBe("failed")
    expect(deliveryOf(await view(admin, ticket.number), written.json.id)?.problem).toBe("author_not_allowed")
    expect((await agent.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply())).status).toBe(404)
  })
})

describe("what each provider's answer means", () => {
  async function sent(values: Record<string, unknown>, settings: Partial<Record<SettingKey, string>> = {}) {
    const admin = await firstAdmin()
    const ticket = await customerTicket()
    const written = await admin.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply(values))
    expect(written.status, JSON.stringify(written.json)).toBe(201)
    const id = written.json.id as string
    const state = await sender(settings).send(id)
    return { admin, ticket, id, state, delivery: deliveryOf(await view(admin, ticket.number), id) }
  }

  it("gives the failover only the recipients SMTP2GO refused at RCPT TO, from the bounce address", async () => {
    const before = failover.received.length
    const result = await sent({
      cc: [{ address: "refuse.ron@example.com", name: "Ron" }],
    })
    expect(result.state).toBe("accepted")
    expect(result.delivery?.recipients).toMatchObject([
      { address: "dana@example.com", state: "accepted", provider: "smtp2go" },
      { address: "refuse.ron@example.com", kind: "cc", state: "accepted", provider: "failover" },
    ])
    expect(failover.received.length).toBe(before + 1)
    expect(failover.received.at(-1)).toMatchObject({ from: BOUNCE, to: ["refuse.ron@example.com"] })
    const ticketRow = await h.tickets()
    expect(await h.participantsOf(ticketRow[0]?.id ?? "")).toContain("refuse.ron@example.com")
  })

  it("sends everything through the failover when SMTP2GO cannot be logged in to", async () => {
    const before = smtp2go.received.length
    const result = await sent({}, { "smtp2go.password": `${smtp2go.password}x` })
    expect(result.state).toBe("accepted")
    expect(result.delivery?.recipients).toMatchObject([{ state: "accepted", provider: "failover" }])
    expect(smtp2go.received.length).toBe(before)
  })

  it("refuses every recipient after the data, and the failover takes them", async () => {
    const result = await sent({ to: [{ address: "reject.dana@example.com", name: null }] })
    expect(result.delivery?.recipients).toMatchObject([{ state: "accepted", provider: "failover" }])
  })

  it("fails without sending anything when no provider is set up", async () => {
    const result = await sent({}, { "smtp2go.host": "", "failover.host": "" })
    expect(result.state).toBe("failed")
    expect(result.delivery).toMatchObject({ state: "failed", problem: "not_configured" })
  })

  it("is unknown after a drop before the final reply: no failover, then the agent sends again or marks it sent", async () => {
    const failoverBefore = failover.received.length
    const result = await sent({
      to: [{ address: "drop.dana@example.com", name: null }],
      cc: [{ address: "ron@example.com", name: null }],
    })
    expect(result.state).toBe("unknown")
    expect(result.delivery?.recipients).toMatchObject([
      { address: "drop.dana@example.com", state: "unknown", provider: "smtp2go" },
      { address: "ron@example.com", state: "unknown", provider: "smtp2go" },
    ])
    expect(failover.received.length).toBe(failoverBefore)

    const [first, second] = await Promise.all([
      result.admin.call("POST", `/api/v1/messages/${result.id}/resend`),
      result.admin.call("POST", `/api/v1/messages/${result.id}/resend`),
    ])
    expect([first?.status, second?.status].sort()).toEqual([200, 409])
    expect(await sender().send(result.id)).toBe("unknown")
    const mark = (address?: string) =>
      result.admin.call("POST", `/api/v1/messages/${result.id}/mark-sent`, address === undefined ? {} : { address })
    expect((await mark()).status).toBe(400)
    expect((await mark("ron@example.com")).status).toBe(200)
    expect(deliveryOf(await view(result.admin, result.ticket.number), result.id)).toMatchObject({
      state: "unknown",
      recipients: [
        { address: "drop.dana@example.com", state: "unknown", marked: false },
        { address: "ron@example.com", state: "accepted", marked: true },
      ],
    })
    expect((await mark("ron@example.com")).json).toEqual({ error: "reply_not_unknown" })
    expect((await mark("drop.dana@example.com")).status).toBe(200)
    expect(deliveryOf(await view(result.admin, result.ticket.number), result.id)).toMatchObject({
      state: "accepted",
      recipients: [
        { state: "accepted", marked: true },
        { state: "accepted", marked: true },
      ],
    })
    expect((await mark("drop.dana@example.com")).json).toEqual({ error: "reply_not_unknown" })
    expect(await h.participantsOf((await h.tickets())[0]?.id ?? "")).toEqual(
      expect.arrayContaining(["drop.dana@example.com", "ron@example.com"]),
    )
    const actions = await h.database.db.select({ action: auditLog.action }).from(auditLog)
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(["message.reply", "message.resend", "message.mark_sent"]),
    )
  })

  it("never sends again what a run that stopped after its claim may have sent", async () => {
    const admin = await firstAdmin()
    const ticket = await customerTicket()
    const written = await admin.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply())
    const id = written.json.id as string
    const stopped = sender(
      {},
      {
        afterClaim: async () => {
          throw new Error("the run stopped")
        },
      },
    )
    await expect(stopped.send(id)).rejects.toThrow("the run stopped")
    const [row] = await h.database.db.select({ state: outbox.state }).from(outbox).where(eq(outbox.messageId, id))
    expect(row?.state).toBe("sending")
    const before = smtp2go.received.length + failover.received.length
    expect(await sender().send(id)).toBe("unknown")
    expect(smtp2go.received.length + failover.received.length).toBe(before)
    expect(deliveryOf(await view(admin, ticket.number), id)?.recipients).toMatchObject([{ state: "unknown" }])
  })
})

describe("attempts that overlap", () => {
  it("an attempt made stale while it was paused after its claim sends nothing and changes nothing (review R3)", async () => {
    const admin = await firstAdmin()
    const ticket = await customerTicket()
    const written = await admin.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply())
    const id = written.json.id as string
    let reached!: () => void
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      reached = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = sender(
      {},
      {
        afterClaim: async () => {
          reached()
          await gate
        },
      },
    ).send(id)
    await paused
    expect(await sender().send(id)).toBe("unknown")
    expect((await admin.call("POST", `/api/v1/messages/${id}/resend`)).status).toBe(200)
    expect(await sender().send(id)).toBe("accepted")
    const received = smtp2go.received.length + failover.received.length
    const [after] = await h.database.db.select().from(outboxRecipient).where(eq(outboxRecipient.messageId, id))
    release()
    await first
    expect(smtp2go.received.length + failover.received.length).toBe(received)
    const [row] = await h.database.db
      .select({ state: outbox.state, attempt: outbox.attempt })
      .from(outbox)
      .where(eq(outbox.messageId, id))
    expect(row).toEqual({ state: "accepted", attempt: null })
    const [now] = await h.database.db.select().from(outboxRecipient).where(eq(outboxRecipient.messageId, id))
    expect(now).toEqual(after)
  })

  it("a claim waits for a move in progress and checks the organization the move leaves (plan 4.1, review S3)", async () => {
    const admin = await firstAdmin()
    const ticket = await customerTicket()
    const written = await admin.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply())
    expect(written.status).toBe(201)
    const id = written.json.id as string
    const received = smtp2go.received.length + failover.received.length
    let sent: Promise<unknown> = Promise.resolve()
    await h.database.db.transaction(async (tx) => {
      await tx
        .select({ id: ticketTable.id })
        .from(ticketTable)
        .where(eq(ticketTable.number, ticket.number))
        .for("update")
      await tx.update(ticketTable).set({ organizationId: otherOrg }).where(eq(ticketTable.number, ticket.number))
      sent = sender().send(id)
      let waiting = false
      for (let tries = 0; tries < 200 && !waiting; tries++) {
        const result = await h.database.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        )
        waiting = (result.rows[0]?.n ?? 0) > 0
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(waiting).toBe(true)
    })
    expect(await sent).toBe("failed")
    expect(deliveryOf(await view(admin, ticket.number), id)).toMatchObject({
      state: "failed",
      problem: "from_not_allowed",
    })
    expect(smtp2go.received.length + failover.received.length).toBe(received)
  })

  it.each(["mark-sent", "resend"] as const)(
    "%s waits for a move in progress and refuses a reply the move took out of the agent's organizations (review S8)",
    async (action) => {
      const admin = await firstAdmin()
      const { b: agent, id: agentId } = await newAgent(admin, "an.agent")
      await new Organizations(h.database.db).addMember(org, agentId, { actor: SYSTEM, ipAddress: null })
      const ticket = await customerTicket()
      const written = await admin.call(
        "POST",
        `/api/v1/tickets/${ticket.number}/messages`,
        reply({
          to: [{ address: "drop.dana@example.com", name: null }],
          cc: [{ address: "ron@example.com", name: null }],
        }),
      )
      expect(written.status).toBe(201)
      const id = written.json.id as string
      expect(await sender().send(id)).toBe("unknown")
      const [ticketRow] = await h.database.db
        .select({ id: ticketTable.id })
        .from(ticketTable)
        .where(eq(ticketTable.number, ticket.number))
      const ticketId = ticketRow?.id ?? ""
      const recipients = () => h.database.db.select().from(outboxRecipient).where(eq(outboxRecipient.messageId, id))
      const before = { recipients: await recipients(), participants: await h.participantsOf(ticketId) }
      expect(before.participants).not.toContain("ron@example.com")
      let answer: Promise<{ status: number; json: unknown }> = Promise.resolve({ status: 0, json: null })
      await h.database.db.transaction(async (tx) => {
        await tx.select({ id: ticketTable.id }).from(ticketTable).where(eq(ticketTable.id, ticketId)).for("update")
        await tx.update(ticketTable).set({ organizationId: otherOrg }).where(eq(ticketTable.id, ticketId))
        answer = agent.call(
          "POST",
          `/api/v1/messages/${id}/${action}`,
          action === "mark-sent" ? { address: "ron@example.com" } : undefined,
        )
        expect(await someoneWaits()).toBe(true)
      })
      const result = await answer
      expect(result.status).toBe(404)
      expect(result.json).toEqual({ error: "not_found" })
      expect(await recipients()).toEqual(before.recipients)
      expect(await h.participantsOf(ticketId)).toEqual(before.participants)
      const [row] = await h.database.db.select({ state: outbox.state }).from(outbox).where(eq(outbox.messageId, id))
      expect(row?.state).toBe("unknown")
      expect(
        await h.database.db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.entityId, id), inArray(auditLog.action, ["message.mark_sent", "message.resend"]))),
      ).toEqual([])
    },
  )

  it("a claim does not hold up the webhook's delivery flag while it waits for a recipient the webhook holds (review S7)", async () => {
    const admin = await firstAdmin()
    const ticket = await customerTicket()
    const written = await admin.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply())
    expect(written.status).toBe(201)
    const id = written.json.id as string
    const [ticketRow] = await h.database.db
      .select({ id: ticketTable.id })
      .from(ticketTable)
      .where(eq(ticketTable.number, ticket.number))
    const ticketId = ticketRow?.id ?? ""
    let sent: Promise<unknown> = Promise.resolve()
    await h.database.db.transaction(async (tx) => {
      await tx.update(outboxRecipient).set({ deliveryRecordedAt: sql`now()` }).where(eq(outboxRecipient.messageId, id))
      sent = sender().send(id)
      expect(await someoneWaits()).toBe(true)
      await refreshDeliveryFlag(tx, ticketId)
    })
    expect(await sent).toBe("accepted")
  })
})

describe("intake knows what Maane sent", () => {
  it("threads a reply that names only Maane's Message-ID, and opens nothing for Maane's own mail coming back", async () => {
    const admin = await firstAdmin()
    const ticket = await customerTicket()
    const written = await admin.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply())
    expect(await sender().send(written.json.id)).toBe("accepted")
    const [ours] = await h.database.db
      .select({ id: message.messageIdHeader })
      .from(message)
      .where(eq(message.id, written.json.id))
    if (!ours?.id) throw new Error("the reply has no Message-ID")

    const answer = h.graph.add(
      mime({ subject: "Thanks", from: "Dana Customer <dana@example.com>", to: SUPPORT, inReplyTo: ours.id }),
    )
    const sent = smtp2go.received.at(-1)
    if (!sent) throw new Error("nothing was sent")
    const echo = h.graph.add(sent.raw)
    await h.round()
    expect((await h.ticketOf(answer))?.number).toBe(ticket.number)
    expect(await h.recordOf(answer)).toMatchObject({ outcome: "joined", matchLayer: "header" })
    expect(await h.recordOf(echo)).toMatchObject({ outcome: "copy", reason: "sent_by_maane" })
    expect(await h.ticketOf(echo)).toBeUndefined()
    expect(await h.tickets()).toHaveLength(1)
  })
})

describe("uploads", () => {
  it("refuses an infected upload and one the scanner could not scan while the policy blocks", async () => {
    const admin = await firstAdmin()
    const infected = await uploadFile(admin, "eicar.txt", eicar())
    expect(infected.status).toBe(202)
    expect(await scanUpload(h.database.db, h.files, infected.json.id)).toBe("infected")
    expect((await admin.call("GET", `/api/v1/uploads/${infected.json.id}`)).json).toMatchObject({
      status: "infected",
      signature: expect.any(String),
    })
    await h.settings.update({ "scanner.address": "127.0.0.1:9" }, SYSTEM)
    const waiting = await uploadFile(admin, "plain.txt", Buffer.from("plain"))
    expect(await scanUpload(h.database.db, h.files, waiting.json.id)).toBe("scanner_unavailable")
    const rows = await h.database.db.select({ content: upload.content }).from(upload)
    expect(rows.every((row) => row.content === null)).toBe(true)
    const [job] = await boss.fetch<{ uploadId: string }>(UPLOAD_SCAN)
    expect(job?.data.uploadId).toBe(infected.json.id)
    expect(
      await h.database.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "file.blocked"))),
    ).toHaveLength(1)
  })

  it("refuses a file larger than the limit before it is kept", async () => {
    const admin = await firstAdmin()
    const limit = await h.settings.get("files.maxBytes")
    const answer = await uploadFile(admin, "big.bin", Buffer.alloc(limit + 1))
    expect(answer.json).toMatchObject({ error: "file_too_large" })
    expect(await h.database.db.select().from(upload)).toHaveLength(0)
  })
})

describe("the SMTP connection test", () => {
  it("signs in with TLS and sends nothing, and says what failed", async () => {
    const before = smtp2go.received.length + failover.received.length
    expect(await smtpTest(workerSettings(), "smtp2go", QUICK)).toMatchObject({ ok: true, problem: null })
    expect(await smtpTest(workerSettings(), "failover", QUICK)).toMatchObject({ ok: true, provider: "failover" })
    expect(
      await smtpTest(workerSettings({ "smtp2go.password": `${smtp2go.password}x` }), "smtp2go", QUICK),
    ).toMatchObject({ ok: false, problem: "auth", code: "EAUTH", response: expect.stringMatching(/^535 /) })
    expect(await smtpTest(workerSettings({ "failover.host": "" }), "failover", QUICK)).toMatchObject({
      ok: false,
      problem: "not_configured",
    })
    const plain = await startStandInSmtp({ noTls: true })
    try {
      const result = await smtpTest(workerSettings({ "smtp2go.port": String(plain.port) }), "smtp2go", QUICK)
      expect(result.ok).toBe(false)
      expect(["tls", "connection"]).toContain(result.problem)
    } finally {
      await plain.close()
    }
    expect(smtp2go.received.length + failover.received.length).toBe(before)
  })
})
