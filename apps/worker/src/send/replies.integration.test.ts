import { randomUUID } from "node:crypto"
import { SYSTEM } from "@maane/server/audit"
import { auditLog, message, outbox, outboxRecipient, supportAddress, upload } from "@maane/server/db/schema"
import { type JobQueue, openJobQueue, SEND_REPLY, UPLOAD_SCAN } from "@maane/server/jobs/queue"
import { Organizations } from "@maane/server/organizations/service"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { createTestApp } from "@maane/server/testing/app"
import { nextIp, TestBrowser, testPassword } from "@maane/server/testing/browser"
import { MESSAGES, type SettingKey, type TicketView, userEmail } from "@maane/shared"
import { and, eq } from "drizzle-orm"
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

// Replies that send (plan 3.1), from the composer's API to the stand-in SMTP servers and back through intake: the server
// app and the worker's sender on one migrated database, the intake harness (stand-in Graph and clamd, a file store in
// a temporary directory), and two stand-in SMTP servers: SMTP2GO (STARTTLS, outcomes by recipient) and the failover
// (TLS from the first byte, accepts everything). Nothing leaves this process.

const QUICK: SmtpTimeouts = { connection: 2000, greeting: 1500, socket: 3000, setup: 4000, send: 5000 }
const SUPPORT = "support@example.com"
const OTHER = "billing@example.com"
const BOUNCE = "bounce@example.com"
// Hebrew from code points: "shalom" and "toda" (thanks).
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
  await h.organization("Example Other", [{ value: OTHER }])
  await h.mode("live")
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

/** The worker's settings: the stand-ins' addresses and credentials, given to this process only. */
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
  return new ReplySender({ db: h.database.db, settings, timeouts: QUICK, afterClaim: options.afterClaim })
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

/** A customer's message through intake: returns its ticket's number and the message's own Message-ID. */
async function customerTicket(subject = "A question", messageId = `${randomUUID()}@mail.example.com`) {
  const graphId = h.graph.add(
    mime({ messageId, subject, from: "Dana Customer <dana@example.com>", to: SUPPORT, text: { content: SHALOM } }),
  )
  await h.round()
  const found = await h.ticketOf(graphId)
  if (!found) throw new Error("no ticket")
  return { number: found.number, referenceCode: found.referenceCode, messageId }
}

/** The multipart upload the composer makes, with the browser's cookies and the headers /api/v1 needs. */
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

/** Uploads and scans a file as the worker would; returns the upload's ID. */
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
      listening: false,
    })
    const file = await scanned(admin, "notes.txt", Buffer.from("The notes of the meeting.\n"))
    const html = `<p dir="auto">${SHALOM}, ${TODA}</p><p dir="auto">The English paragraph.</p>`
    const written = await admin.call(
      "POST",
      `/api/v1/tickets/${ticket.number}/messages`,
      reply({ html, uploads: [file] }),
    )
    expect(written.status, JSON.stringify(written.json)).toBe(201)
    const id = written.json.id as string

    // The message and its job were written together.
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
    const reference = `${MESSAGES.he.mail.reference}: ${ticket.referenceCode}`
    expect(parsed.text?.startsWith(reference)).toBe(true)
    expect(parsed.text).toContain(`${SHALOM}, ${TODA}`)
    expect(parsed.text).toContain("The English paragraph.")
    expect(parsed.html).toContain(`<span dir="ltr">${ticket.referenceCode}</span>`)
    expect(parsed.html).toContain('<p dir="auto">The English paragraph.</p>')
    expect(parsed.html).toMatch(/<html dir="rtl">/)
    expect(parsed.attachments.map((a) => [a.filename, a.content.toString()])).toEqual([
      ["notes.txt", "The notes of the meeting.\n"],
    ])
    // A customer's client finds the ticket again by the reference code and the subject number intake reads.
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
    expect(after.ticket.status).toBe("open")
    const [recipient] = await h.database.db.select().from(outboxRecipient).where(eq(outboxRecipient.messageId, id))
    expect(recipient?.response).toContain(`OK id=${sent.queueId}`)
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
    // A part of another ticket's message.
    const otherNote = await admin.call(
      "POST",
      `/api/v1/tickets/${other.number}/messages`,
      reply({ kind: "note", uploads: [mine] }),
    )
    const otherPart = (await view(admin, other.number)).messages.find((m) => m.id === otherNote.json.id)?.attachments[0]
      ?.id
    expect(otherPart).toBeTruthy()
    expect((await post(admin, { parts: [otherPart] })).json).toEqual({ error: "attachment_invalid" })
    // Still scanning: not attachable yet.
    const pending = await uploadFile(admin, "late.txt", Buffer.from("late"))
    expect((await post(admin, { uploads: [pending.json.id] })).json).toEqual({ error: "attachment_invalid" })
    // A file of an internal note of the same ticket never goes to a customer (review R1).
    const ownNote = await admin.call(
      "POST",
      `/api/v1/tickets/${ticket.number}/messages`,
      reply({ kind: "note", uploads: [mine] }),
    )
    const notePart = (await view(admin, ticket.number)).messages.find((m) => m.id === ownNote.json.id)?.attachments[0]
      ?.id
    expect(notePart).toBeTruthy()
    expect((await post(admin, { parts: [notePart] })).json).toEqual({ error: "attachment_invalid" })
    // Its own upload and a file of an earlier reply are fine.
    const firstReply = await post(admin, { uploads: [mine] })
    expect(firstReply.status).toBe(201)
    const replyPart = (await view(admin, ticket.number)).messages.find((m) => m.id === firstReply.json.id)
      ?.attachments[0]?.id
    expect((await post(admin, { uploads: [mine], parts: [replyPart] })).status).toBe(201)
    // An upload is its uploader's alone, also to read.
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
    // Written, then the address leaves the organization before the worker sends.
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

  it("refuses replies while intake listens, at the composer and at the send point, and still writes notes", async () => {
    const admin = await firstAdmin()
    const ticket = await customerTicket()
    const written = await admin.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply())
    expect(written.status).toBe(201)
    await h.mode("listening")
    expect((await view(admin, ticket.number)).compose.listening).toBe(true)
    expect((await admin.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply())).json).toEqual({
      error: "listening_mode",
    })
    const note = await admin.call("POST", `/api/v1/tickets/${ticket.number}/messages`, reply({ kind: "note" }))
    expect(note.status).toBe(201)
    const received = smtp2go.received.length
    expect(await sender().send(written.json.id)).toBe("failed")
    const v = await view(admin, ticket.number)
    expect(deliveryOf(v, written.json.id)).toMatchObject({ state: "failed", problem: "listening" })
    expect(v.messages.find((m) => m.id === note.json.id)).toMatchObject({ direction: "note", delivery: null })
    expect(smtp2go.received.length).toBe(received)
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
    // Out of the organization, the agent cannot reach the ticket at all.
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
    // Ron, whom the agent added, became a participant once accepted.
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

    // "Send again": two clicks queue one attempt.
    const [first, second] = await Promise.all([
      result.admin.call("POST", `/api/v1/messages/${result.id}/resend`),
      result.admin.call("POST", `/api/v1/messages/${result.id}/resend`),
    ])
    expect([first?.status, second?.status].sort()).toEqual([200, 409])
    expect(await sender().send(result.id)).toBe("unknown")
    // "Mark as sent", one recipient at a time (review R4): the other stays unknown, and so does the reply.
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
    // Marked as sent, Ron (whom the agent added) is a participant, as one a provider accepted would be.
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
    // The first attempt claims, then stops before it sends, as a stalled worker would.
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
    // A redelivered job finds it `sending` and marks it unknown; the agent sends again; a second attempt sends.
    expect(await sender().send(id)).toBe("unknown")
    expect((await admin.call("POST", `/api/v1/messages/${id}/resend`)).status).toBe(200)
    expect(await sender().send(id)).toBe("accepted")
    const received = smtp2go.received.length + failover.received.length
    const [after] = await h.database.db.select().from(outboxRecipient).where(eq(outboxRecipient.messageId, id))
    // The first attempt goes on: it sends nothing and writes nothing.
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

    // The customer answers our reply: no reference code, no [#n], only In-Reply-To.
    const answer = h.graph.add(
      mime({ subject: "Thanks", from: "Dana Customer <dana@example.com>", to: SUPPORT, inReplyTo: ours.id }),
    )
    // Our own reply comes back into the mailbox, as a provider's copy would.
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
