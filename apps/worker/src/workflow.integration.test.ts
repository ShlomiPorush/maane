import { randomUUID } from "node:crypto"
import { SYSTEM } from "@maane/server/audit"
import {
  auditLog,
  category,
  intakeConversationTicketLink,
  intakeRecord,
  message,
  ticket,
  ticketCategory,
  ticketParticipant,
  ticketPendingReference,
} from "@maane/server/db/schema"
import { type JobQueue, openJobQueue } from "@maane/server/jobs/queue"
import { Organizations } from "@maane/server/organizations/service"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { createTestApp } from "@maane/server/testing/app"
import { nextIp, TestBrowser, testPassword } from "@maane/server/testing/browser"
import { customerReplyCondition, isCustomerReply } from "@maane/server/tickets/customer-reply"
import { type SettingKey, type TicketStatus, type TicketView, userEmail } from "@maane/shared"
import { and, asc, count, eq, sql } from "drizzle-orm"
import { simpleParser } from "mailparser"
import { PgBoss } from "pg-boss"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { ReplySender } from "./send/sender.ts"
import type { SmtpTimeouts } from "./send/smtp.ts"
import { type StandInClamd, startStandInClamd } from "./testing/clamd.ts"
import { type IntakeHarness, startIntake } from "./testing/intake.ts"
import { fromCodePoints, mime } from "./testing/mime.ts"
import { type StandInSmtp, startStandInSmtp } from "./testing/smtp.ts"

// The workflow of plan 4.1 from the API through intake and the sender: statuses and who may set them, what a customer
// reply is (and every kind of mail that is not one), the follow-up of a closed ticket, "Send and set pending", moving a
// ticket to another organization, and categories. The server app, intake (stand-in Graph and clamd), and the worker's
// sender (stand-in SMTP) share one migrated database. Nothing leaves this process.

const QUICK: SmtpTimeouts = { connection: 2000, greeting: 1500, socket: 3000, setup: 4000, send: 5000 }
const SUPPORT = "support@example.com"
const OTHER = "billing@example.com"
const BOUNCE = "bounce@example.com"
const TODA = fromCodePoints(0x5ea, 0x5d5, 0x5d3, 0x5d4)

let clamd: StandInClamd
let smtp2go: StandInSmtp
let failover: StandInSmtp
let h: IntakeHarness
let app: ReturnType<typeof createTestApp>
let queue: JobQueue
let boss: PgBoss
let org: string
let other: string
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
  other = await h.organization("Example Other", [{ value: OTHER }])
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

function sender() {
  const values: Partial<Record<SettingKey, string>> = {
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
  }
  const settings = new Settings(h.database.db, createSettingsCipher([{ version: 1, value: h.cipherKey }]), values)
  return new ReplySender({
    db: h.database.db,
    settings,
    queue: (jobs, name, data, startAfter) => queue.sendIn(jobs, name, data, { startAfter }),
    timeouts: QUICK,
  })
}

const browser = () => new TestBrowser(app.fetch, nextIp())
const db = () => h.database.db

async function firstAdmin() {
  const b = browser()
  expect((await b.setup("first.admin", password)).status).toBe(200)
  await b.enroll(password)
  return b
}

/** An agent signed in with two-factor, a member of these organizations. */
async function newAgent(admin: TestBrowser, name: string, organizations: string[]) {
  const created = await admin.call("POST", "/api/auth/admin/create-user", {
    email: userEmail(name),
    password,
    name,
    role: "agent",
    data: { username: name },
  })
  expect(created.status).toBe(200)
  const id = created.json.user.id as string
  for (const organizationId of organizations)
    await new Organizations(db()).addMember(organizationId, id, { actor: SYSTEM, ipAddress: null })
  const b = browser()
  expect((await b.passwordSignIn(name, password)).status).toBe(200)
  await b.enroll(password)
  return b
}

const DANA = "Dana Customer <dana@example.com>"

/** A customer's message through intake: its ticket's number and ID, and the message's own Message-ID. */
async function customerTicket(subject = "A question") {
  const messageId = `${randomUUID()}@mail.example.com`
  const graphId = h.graph.add(mime({ messageId, subject, from: DANA, to: SUPPORT, text: { content: TODA } }))
  await h.round()
  const found = await h.ticketOf(graphId)
  if (!found) throw new Error("no ticket")
  return { number: found.number, id: found.id, messageId, graphId }
}

/** The customer answers the ticket's first message (In-Reply-To), through intake. Returns the new message's Graph ID. */
async function customerAnswers(t: { messageId: string }, values: Parameters<typeof mime>[0] = {}) {
  const graphId = h.graph.add(
    mime({ from: DANA, to: SUPPORT, subject: "Re: A question", inReplyTo: t.messageId, ...values }),
  )
  await h.round()
  return graphId
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

async function statusOf(id: string): Promise<string | undefined> {
  return (await db().select({ status: ticket.status }).from(ticket).where(eq(ticket.id, id)))[0]?.status
}

const setStatus = (b: TestBrowser, number: number, status: string) =>
  b.call("PUT", `/api/v1/tickets/${number}/status`, { status })

/** The audit rows of status changes of one ticket, oldest first. */
async function statusChanges(ticketId: string) {
  const rows = await db()
    .select({ actor: auditLog.actorLabel, details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.action, "ticket.status"), eq(auditLog.entityId, ticketId)))
    .orderBy(asc(auditLog.id))
  return rows.map((row) => ({ actor: row.actor, ...(row.details as { via?: string } & Record<string, unknown>) }))
}

async function messagesOf(ticketId: string): Promise<number> {
  const [row] = await db().select({ n: count() }).from(message).where(eq(message.ticketId, ticketId))
  return row?.n ?? 0
}

describe("statuses", () => {
  it("lets an agent set every status but closed, which only an admin sets and leaves, each change audited once", async () => {
    const admin = await firstAdmin()
    const agent = await newAgent(admin, "an.agent", [org])
    const outsider = await newAgent(admin, "an.outsider", [other])
    const t = await customerTicket()
    const steps: TicketStatus[] = ["open", "pending", "on_hold", "solved", "new", "open"]
    for (const status of steps) {
      expect((await setStatus(agent, t.number, status)).status, status).toBe(200)
      expect(await statusOf(t.id)).toBe(status)
    }
    // The same status again changes nothing and writes nothing.
    expect((await setStatus(agent, t.number, "open")).status).toBe(200)
    expect(await statusChanges(t.id)).toHaveLength(steps.length)

    expect((await setStatus(agent, t.number, "closed")).json).toEqual({ error: "status_admin_only" })
    expect((await setStatus(agent, t.number, "closed")).status).toBe(403)
    expect(await statusOf(t.id)).toBe("open")
    expect((await setStatus(admin, t.number, "closed")).status).toBe(200)
    expect((await setStatus(agent, t.number, "open")).json).toEqual({ error: "status_admin_only" })
    expect(await statusOf(t.id)).toBe("closed")
    expect((await setStatus(admin, t.number, "solved")).status).toBe(200)

    expect((await setStatus(outsider, t.number, "pending")).status).toBe(404)
    expect((await setStatus(agent, t.number, "archived")).json).toEqual({ error: "request_invalid" })
    expect((await setStatus(agent, 999_999, "open")).status).toBe(404)
    expect(await statusChanges(t.id)).toEqual([
      { actor: "an.agent", ticket: t.number, from: "new", to: "open", via: "agent" },
      { actor: "an.agent", ticket: t.number, from: "open", to: "pending", via: "agent" },
      { actor: "an.agent", ticket: t.number, from: "pending", to: "on_hold", via: "agent" },
      { actor: "an.agent", ticket: t.number, from: "on_hold", to: "solved", via: "agent" },
      { actor: "an.agent", ticket: t.number, from: "solved", to: "new", via: "agent" },
      { actor: "an.agent", ticket: t.number, from: "new", to: "open", via: "agent" },
      { actor: "first.admin", ticket: t.number, from: "open", to: "closed", via: "agent" },
      { actor: "first.admin", ticket: t.number, from: "closed", to: "solved", via: "agent" },
    ])
    expect((await view(agent, t.number)).ticket.status).toBe("solved")
  })
})

describe("send and set pending", () => {
  it("sets pending in the transaction that writes the reply; a plain reply and a note leave the status", async () => {
    const admin = await firstAdmin()
    const agent = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const post = (values: Record<string, unknown>) =>
      agent.call("POST", `/api/v1/tickets/${t.number}/messages`, reply(values))

    expect((await post({ kind: "note", from: null, to: [] })).status).toBe(201)
    expect(await statusOf(t.id)).toBe("new")
    const plain = await post({ setPending: false })
    expect(plain.status).toBe(201)
    expect(await statusOf(t.id)).toBe("new")
    expect((await post({})).status).toBe(201)
    expect(await statusOf(t.id)).toBe("new")

    // The default action of the composer: pending as soon as the reply is written, before the worker sends it.
    const pending = await post({ setPending: true })
    expect(pending.status).toBe(201)
    expect(await statusOf(t.id)).toBe("pending")
    expect(await statusChanges(t.id)).toEqual([
      { actor: "an.agent", ticket: t.number, from: "new", to: "pending", via: "reply" },
    ])
    expect(await sender().send(pending.json.id)).toBe("accepted")
    expect(await statusOf(t.id)).toBe("pending")
    // A note on a pending ticket leaves it pending, and so does a note with the flag (it applies to replies only).
    expect((await post({ kind: "note", from: null, to: [], setPending: true })).status).toBe(201)
    await db().update(ticket).set({ status: "open" }).where(eq(ticket.id, t.id))
    expect((await post({ kind: "note", from: null, to: [], setPending: true })).status).toBe(201)
    expect(await statusOf(t.id)).toBe("open")
  })

  it("refuses set pending on a closed ticket for an agent, and writes nothing of the reply (one transaction)", async () => {
    const admin = await firstAdmin()
    const agent = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    expect((await setStatus(admin, t.number, "closed")).status).toBe(200)
    const before = await messagesOf(t.id)
    const refused = await agent.call("POST", `/api/v1/tickets/${t.number}/messages`, reply({ setPending: true }))
    expect(refused.status).toBe(403)
    expect(refused.json).toEqual({ error: "status_admin_only" })
    expect(await messagesOf(t.id)).toBe(before)
    expect(await statusOf(t.id)).toBe("closed")
    // A plain reply on a closed ticket is written and leaves it closed.
    expect((await agent.call("POST", `/api/v1/tickets/${t.number}/messages`, reply())).status).toBe(201)
    expect(await statusOf(t.id)).toBe("closed")
  })
})

describe("a customer reply", () => {
  it("moves pending, on hold, and solved back to open in the transaction that attaches it, audited as the system", async () => {
    const admin = await firstAdmin()
    const t = await customerTicket()
    for (const status of ["pending", "on_hold", "solved"] as const) {
      expect((await setStatus(admin, t.number, status)).status).toBe(200)
      const answer = await customerAnswers(t)
      expect((await h.ticketOf(answer))?.id).toBe(t.id)
      const record = await h.recordOf(answer)
      expect(record).toMatchObject({ outcome: "joined", mode: "live", classification: "customer" })
      expect(record && isCustomerReply(record)).toBe(true)
      expect(await statusOf(t.id), status).toBe("open")
    }
    const changes = await statusChanges(t.id)
    expect(changes.filter((change) => change.via === "customer_reply")).toEqual([
      { actor: "system", ticket: t.number, from: "pending", to: "open", via: "customer_reply" },
      { actor: "system", ticket: t.number, from: "on_hold", to: "open", via: "customer_reply" },
      { actor: "system", ticket: t.number, from: "solved", to: "open", via: "customer_reply" },
    ])
    // The definition over stored records finds exactly these three.
    const [found] = await db()
      .select({ n: count() })
      .from(intakeRecord)
      .where(and(eq(intakeRecord.ticketId, t.id), customerReplyCondition()))
    expect(found?.n).toBe(3)
  })

  it("is never automated mail, Maane's own mail, a copy, or anything listening records: a pending ticket stays pending", async () => {
    const admin = await firstAdmin()
    const t = await customerTicket()
    const written = await admin.call("POST", `/api/v1/tickets/${t.number}/messages`, reply({ setPending: true }))
    expect(await sender().send(written.json.id)).toBe("accepted")
    expect(await statusOf(t.id)).toBe("pending")
    const [ours] = await db()
      .select({ id: message.messageIdHeader })
      .from(message)
      .where(eq(message.id, written.json.id))
    const replyId = ours?.id ?? ""

    // Each would reach the ticket by its headers if it were the customer's mail: In-Reply-To names the ticket's mail.
    const dsn = h.graph.add(
      mime({
        from: "Mail Delivery System <MAILER-DAEMON@example.com>",
        to: BOUNCE,
        subject: "Undelivered Mail Returned to Sender",
        inReplyTo: replyId,
        report: {
          type: "delivery-status",
          parts: [
            { contentType: "text/plain", body: "Your message could not be delivered." },
            {
              contentType: "message/delivery-status",
              body: "Reporting-MTA: dns; mx.example.com\r\n\r\nFinal-Recipient: rfc822; dana@example.com\r\nAction: failed\r\nStatus: 5.1.1",
            },
            { contentType: "text/rfc822-headers", body: `Message-ID: <${replyId}>\r\nFrom: ${SUPPORT}` },
          ],
        },
      }),
    )
    const receipt = h.graph.add(
      mime({
        from: DANA,
        to: SUPPORT,
        subject: "Read: A question",
        inReplyTo: replyId,
        report: {
          type: "disposition-notification",
          parts: [
            { contentType: "text/plain", body: "Your message was displayed." },
            {
              contentType: "message/disposition-notification",
              body: `Final-Recipient: rfc822; dana@example.com\r\nOriginal-Message-ID: <${replyId}>\r\nDisposition: manual-action/MDN-sent-manually; displayed`,
            },
          ],
        },
      }),
    )
    const outOfOffice = h.graph.add(
      mime({ from: DANA, to: SUPPORT, inReplyTo: replyId, headers: [["Auto-Submitted", "auto-replied"]] }),
    )
    const list = h.graph.add(
      mime({ from: DANA, to: SUPPORT, inReplyTo: replyId, headers: [["List-Id", "<news.example.com>"]] }),
    )
    // Maane's own reply coming back into the mailbox, and a copy of the customer's first message.
    const echo = h.graph.add(smtp2go.received.at(-1)?.raw ?? Buffer.alloc(0))
    const copy = h.graph.add(
      mime({ messageId: t.messageId, subject: "A question", from: DANA, to: SUPPORT, text: { content: TODA } }),
    )
    await h.round()

    for (const [name, id, outcome] of [
      ["a delivery status notification", dsn, "automated"],
      ["a read receipt", receipt, "automated"],
      ["an out-of-office reply", outOfOffice, "automated"],
      ["mailing list mail", list, "automated"],
      ["Maane's own reply", echo, "copy"],
      ["a copy", copy, "copy"],
    ] as const) {
      const record = await h.recordOf(id)
      expect(record?.outcome, name).toBe(outcome)
      expect(record && isCustomerReply(record), name).toBe(false)
      expect(await statusOf(t.id), name).toBe("pending")
    }
    // The delivery report about Maane's reply still updates its delivery (plan 3.3).
    expect(await h.recordOf(dsn)).toMatchObject({ matchedTicketId: t.id })
    expect((await view(admin, t.number)).ticket.reviewFlags).toContain("delivery_failed")

    // Listening: the customer's real reply is recorded as what live mode would do, and changes no ticket.
    await h.mode("listening")
    const heard = await customerAnswers(t)
    const record = await h.recordOf(heard)
    expect(record).toMatchObject({ mode: "listening", outcome: "joined", matchedTicketId: t.id, ticketId: null })
    expect(record && isCustomerReply(record)).toBe(false)
    expect(await statusOf(t.id)).toBe("pending")
    const [found] = await db()
      .select({ n: count() })
      .from(intakeRecord)
      .where(and(eq(intakeRecord.matchedTicketId, t.id), customerReplyCondition()))
    expect(found?.n).toBe(0)

    // Live again, the same kind of mail is a customer reply.
    await h.mode("live")
    const answer = await customerAnswers(t)
    expect(await h.recordOf(answer)).toMatchObject({ outcome: "joined", mode: "live" })
    expect(await statusOf(t.id)).toBe("open")
  })

  it("to a closed ticket opens a follow-up linked to it, and leaves the closed ticket exactly as it was", async () => {
    const admin = await firstAdmin()
    const t = await customerTicket()
    expect((await setStatus(admin, t.number, "closed")).status).toBe(200)
    const [before] = await db().select().from(ticket).where(eq(ticket.id, t.id))
    const participants = await h.participantsOf(t.id)
    const messages = await messagesOf(t.id)

    const answer = await customerAnswers(t, { references: [t.messageId, "missing@mail.example.com"] })
    const followUp = await h.ticketOf(answer)
    expect(followUp?.id).not.toBe(t.id)
    expect(followUp).toMatchObject({ status: "new", reviewFlags: [], organizationId: org })
    expect(await h.recordOf(answer)).toMatchObject({ outcome: "new_linked_ticket", reason: "follow_up" })
    expect(await h.linksOf(followUp?.id ?? "")).toEqual([{ linkedTicketId: t.id, reason: "follow_up" }])

    const [after] = await db().select().from(ticket).where(eq(ticket.id, t.id))
    expect(after).toEqual(before)
    expect(await h.participantsOf(t.id)).toEqual(participants)
    expect(await messagesOf(t.id)).toBe(messages)
    expect(await db().select().from(ticketPendingReference).where(eq(ticketPendingReference.ticketId, t.id))).toEqual(
      [],
    )
    // Both tickets show the link, the follow-up's way and the closed ticket's way.
    expect((await view(admin, followUp?.number ?? 0)).links).toEqual([{ number: t.number, reason: "follow_up" }])
    expect((await view(admin, t.number)).links).toEqual([{ number: followUp?.number, reason: "follow_up" }])
    // The follow-up is the customer's new ticket: a further reply joins it, and the closed ticket stays closed.
    const again = await customerAnswers({ messageId: (await h.messageOf(answer)).messageIdHeader ?? "" })
    expect((await h.ticketOf(again))?.id).toBe(followUp?.id)
    expect(await statusOf(t.id)).toBe("closed")

    // Listening records the same decision without a ticket: a conversation linked to the closed ticket.
    await h.mode("listening")
    const heard = await customerAnswers(t)
    expect(await h.recordOf(heard)).toMatchObject({ outcome: "new_linked_ticket", reason: "follow_up", ticketId: null })
    const [link] = await db()
      .select({ reason: intakeConversationTicketLink.reason })
      .from(intakeConversationTicketLink)
      .where(eq(intakeConversationTicketLink.ticketId, t.id))
    expect(link?.reason).toBe("follow_up")
    expect(await h.tickets()).toHaveLength(2)
  })
})

describe("moving a ticket to another organization", () => {
  it("lets an admin, or an agent of both organizations, move it; audited; its replies then come from the new organization", async () => {
    const admin = await firstAdmin()
    const both = await newAgent(admin, "agent.both", [org, other])
    const one = await newAgent(admin, "agent.one", [org])
    const outsider = await newAgent(admin, "agent.other", [other])
    const t = await customerTicket()
    const move = (b: TestBrowser, organizationId: string) =>
      b.call("PUT", `/api/v1/tickets/${t.number}/organization`, { organizationId })

    expect((await view(one, t.number)).moveTargets).toEqual([])
    expect((await view(both, t.number)).moveTargets).toEqual([{ id: other, name: "Example Other" }])
    expect((await view(admin, t.number)).moveTargets).toEqual([{ id: other, name: "Example Other" }])
    // A reply written before the move, from the old organization's address.
    const early = await both.call("POST", `/api/v1/tickets/${t.number}/messages`, reply())
    expect(early.status).toBe(201)

    expect((await move(one, other)).json).toEqual({ error: "move_not_allowed" })
    expect((await move(one, other)).status).toBe(403)
    expect((await move(outsider, other)).status).toBe(404)
    expect((await move(both, randomUUID())).status).toBe(403)
    expect((await move(admin, randomUUID())).json).toEqual({ error: "organization_not_found" })
    expect((await move(both, other)).status).toBe(200)
    expect((await db().select().from(ticket).where(eq(ticket.id, t.id)))[0]?.organizationId).toBe(other)
    // The ticket now belongs to the other organization: the agent of the old one no longer sees it.
    expect((await one.call("GET", `/api/v1/tickets/${t.number}`)).status).toBe(404)
    expect((await view(outsider, t.number)).ticket.organization).toEqual({ id: other, name: "Example Other" })
    expect((await move(admin, org)).status).toBe(200)
    expect((await move(admin, other)).status).toBe(200)
    const moves = await db()
      .select({ actor: auditLog.actorLabel, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.action, "ticket.move"), eq(auditLog.entityId, t.id)))
      .orderBy(asc(auditLog.id))
    expect(moves).toEqual([
      {
        actor: "agent.both",
        details: {
          ticket: t.number,
          from: { id: org, name: "Example Support" },
          to: { id: other, name: "Example Other" },
        },
      },
      {
        actor: "first.admin",
        details: {
          ticket: t.number,
          from: { id: other, name: "Example Other" },
          to: { id: org, name: "Example Support" },
        },
      },
      {
        actor: "first.admin",
        details: {
          ticket: t.number,
          from: { id: org, name: "Example Support" },
          to: { id: other, name: "Example Other" },
        },
      },
    ])

    // From now on the composer offers the new organization's addresses, the old one is refused when written and when
    // sent, and a reply goes out from the new address.
    const compose = (await view(both, t.number)).compose
    expect(compose.from).toEqual([OTHER])
    expect(compose.defaultFrom).toBe(OTHER)
    expect(compose.senderName).toContain("(Example Other)")
    expect((await both.call("POST", `/api/v1/tickets/${t.number}/messages`, reply())).json).toEqual({
      error: "from_not_allowed",
    })
    expect(await sender().send(early.json.id)).toBe("failed")
    const written = await both.call("POST", `/api/v1/tickets/${t.number}/messages`, reply({ from: OTHER }))
    expect(written.status).toBe(201)
    expect(await sender().send(written.json.id)).toBe("accepted")
    const sent = smtp2go.received.at(-1)
    const parsed = await simpleParser(sent?.raw ?? Buffer.alloc(0))
    expect(parsed.from?.value[0]?.address).toBe(OTHER)
    expect(parsed.from?.value[0]?.name).toContain("(Example Other)")
  })

  it("refuses a move to an organization with no address to send the ticket's replies from (review S4)", async () => {
    const admin = await firstAdmin()
    const patterns = await h.organization("Example Patterns", [{ value: "*@sales.example.com", kind: "pattern" }])
    const t = await customerTicket()
    const move = (organizationId: string) =>
      admin.call("PUT", `/api/v1/tickets/${t.number}/organization`, { organizationId })
    const refused = await move(patterns)
    expect(refused.status).toBe(409)
    expect(refused.json).toEqual({ error: "move_no_sending_address" })
    expect((await db().select().from(ticket).where(eq(ticket.id, t.id)))[0]?.organizationId).toBe(org)
    expect(
      await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "ticket.move"), eq(auditLog.entityId, t.id))),
    ).toEqual([])
    // An organization with an exact address takes it, and its replies come from that address.
    expect((await move(other)).status).toBe(200)
  })

  it("writes no note to a ticket moved out of its author's organizations while the note was written (review S1)", async () => {
    const admin = await firstAdmin()
    const one = await newAgent(admin, "agent.one", [org])
    const t = await customerTicket()
    const before = await messagesOf(t.id)
    let posted: Promise<{ status: number; json: unknown }> = Promise.resolve({ status: 0, json: null })
    // A move holds the ticket row as Workflow.move does (FOR UPDATE) while the agent's note is written.
    await db().transaction(async (tx) => {
      await tx.select({ id: ticket.id }).from(ticket).where(eq(ticket.id, t.id)).for("update")
      await tx.update(ticket).set({ organizationId: other }).where(eq(ticket.id, t.id))
      posted = one.call("POST", `/api/v1/tickets/${t.number}/messages`, reply({ kind: "note", from: null, to: [] }))
      // The note waits on the ticket's lock: bounded, and a note that does not wait fails here.
      let waiting = false
      for (let tries = 0; tries < 200 && !waiting; tries++) {
        const result = await db().execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        )
        waiting = (result.rows[0]?.n ?? 0) > 0
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(waiting).toBe(true)
    })
    const answer = await posted
    expect(answer.status).toBe(404)
    expect(answer.json).toEqual({ error: "not_found" })
    expect(await messagesOf(t.id)).toBe(before)
  })
})

describe("categories", () => {
  it("are one list admins manage; agents set any number of them on a ticket; deleting one removes it from tickets", async () => {
    const admin = await firstAdmin()
    const agent = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const create = (b: TestBrowser, name: string) => b.call("POST", "/api/v1/admin/categories", { name })

    const billing = await create(admin, "  Billing ")
    expect(billing.status).toBe(201)
    expect(billing.json.category).toMatchObject({ name: "Billing" })
    const shipping = (await create(admin, "Shipping")).json.category.id as string
    const billingId = billing.json.category.id as string
    expect((await create(admin, "billing")).json).toMatchObject({ error: "category_name_taken" })
    expect((await create(admin, "")).json).toMatchObject({ error: "category_name_invalid" })
    expect((await create(admin, "x".repeat(81))).json).toMatchObject({ error: "category_name_invalid" })
    expect((await create(agent, "Agents")).status).toBe(403)
    expect((await agent.call("GET", "/api/v1/admin/categories")).status).toBe(403)
    expect((await admin.call("PATCH", `/api/v1/admin/categories/${billingId}`, { name: "Invoices" })).status).toBe(200)
    expect((await admin.call("PATCH", `/api/v1/admin/categories/${randomUUID()}`, { name: "X" })).status).toBe(404)

    const set = (b: TestBrowser, categories: string[]) =>
      b.call("PUT", `/api/v1/tickets/${t.number}/categories`, { categories })
    expect((await set(agent, [billingId, shipping])).status).toBe(200)
    expect((await view(agent, t.number)).ticket.categories).toEqual([
      { id: billingId, name: "Invoices" },
      { id: shipping, name: "Shipping" },
    ])
    expect((await view(agent, t.number)).categories.map((c) => c.name)).toEqual(["Invoices", "Shipping"])
    expect((await set(agent, [shipping, randomUUID()])).json).toEqual({ error: "category_not_found" })
    expect((await set(agent, [shipping])).status).toBe(200)
    expect((await set(agent, [shipping])).status).toBe(200)
    expect((await admin.call("GET", "/api/v1/admin/categories")).json.categories).toMatchObject([
      { name: "Invoices", tickets: 0 },
      { name: "Shipping", tickets: 1 },
    ])

    expect((await admin.call("DELETE", `/api/v1/admin/categories/${shipping}`)).status).toBe(200)
    expect((await view(agent, t.number)).ticket.categories).toEqual([])
    expect(await db().select().from(ticketCategory)).toEqual([])
    expect(await db().select({ name: category.name }).from(category)).toEqual([{ name: "Invoices" }])
    expect((await admin.call("DELETE", `/api/v1/admin/categories/${shipping}`)).status).toBe(404)

    const audit = await db()
      .select({ action: auditLog.action, details: auditLog.details })
      .from(auditLog)
      .where(eq(auditLog.entityType, "category"))
      .orderBy(asc(auditLog.id))
    expect(audit).toEqual([
      { action: "category.create", details: { name: "Billing" } },
      { action: "category.create", details: { name: "Shipping" } },
      { action: "category.rename", details: { name: "Invoices", previous: "Billing" } },
      { action: "category.delete", details: { name: "Shipping" } },
    ])
    const changes = await db()
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(eq(auditLog.action, "ticket.categories"))
      .orderBy(asc(auditLog.id))
    expect(changes.map((row) => row.details)).toEqual([
      { ticket: t.number, added: ["Invoices", "Shipping"], removed: [] },
      { ticket: t.number, added: [], removed: ["Invoices"] },
    ])
    // A participant row was never touched by any of this.
    expect(await db().select().from(ticketParticipant).where(eq(ticketParticipant.ticketId, t.id))).toHaveLength(1)
  })
})
