import { randomUUID } from "node:crypto"
import { SYSTEM } from "@maane/server/audit"
import { auditLog, message, outbox, ticket, timedAction } from "@maane/server/db/schema"
import { type JobQueue, openJobQueue, SEND_REPLY, SNOOZE_END, TIMED_ACTION } from "@maane/server/jobs/queue"
import { Organizations } from "@maane/server/organizations/service"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { createTestApp } from "@maane/server/testing/app"
import { nextIp, TestBrowser, testPassword } from "@maane/server/testing/browser"
import { snoozeEnded } from "@maane/server/tickets/snooze"
import { type ScheduledReplyView, type SettingKey, type TicketList, type TicketView, userEmail } from "@maane/shared"
import { and, asc, count, eq, sql } from "drizzle-orm"
import { simpleParser } from "mailparser"
import { PgBoss } from "pg-boss"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { requeueOverdue, TimedActions } from "./actions/run.ts"
import { ReplySender } from "./send/sender.ts"
import type { SmtpTimeouts } from "./send/smtp.ts"
import { type StandInClamd, startStandInClamd } from "./testing/clamd.ts"
import { type IntakeHarness, startIntake } from "./testing/intake.ts"
import { fromCodePoints, mime } from "./testing/mime.ts"
import { type StandInSmtp, startStandInSmtp } from "./testing/smtp.ts"

const QUICK: SmtpTimeouts = { connection: 2000, greeting: 1500, socket: 3000, setup: 4000, send: 5000 }
const SUPPORT = "support@example.com"
const OTHER = "billing@example.com"
const BOUNCE = "bounce@example.com"
const TODA = fromCodePoints(0x5ea, 0x5d5, 0x5d3, 0x5d4)
const DANA = "Dana Customer <dana@example.com>"
const HOUR = 3_600_000

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

const db = () => h.database.db
const browser = () => new TestBrowser(app.fetch, nextIp())

function sender(options: { afterClaim?: (id: string) => Promise<void> } = {}) {
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
    ...options,
  })
}

const actions = () =>
  new TimedActions({
    db: db(),
    settings: new Settings(h.database.db, createSettingsCipher([{ version: 1, value: h.cipherKey }]), {}),
    queue: (tx, name, data) => boss.send(name, data, { db: tx }),
  })

async function firstAdmin() {
  const b = browser()
  expect((await b.setup("first.admin", password)).status).toBe(200)
  await b.enroll(password)
  return b
}

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
  return { b, id }
}

async function customerTicket(subject = "A question") {
  const messageId = `${randomUUID()}@mail.example.com`
  const graphId = h.graph.add(mime({ messageId, subject, from: DANA, to: SUPPORT, text: { content: TODA } }))
  await h.round()
  const found = await h.ticketOf(graphId)
  if (!found) throw new Error("no ticket")
  return { number: found.number, id: found.id, messageId }
}

async function customerAnswers(t: { messageId: string }) {
  h.graph.add(
    mime({ from: DANA, to: SUPPORT, subject: "Re: A question", inReplyTo: t.messageId, text: { content: TODA } }),
  )
  await h.round()
}

const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString()

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

async function scheduledOf(b: TestBrowser, number: number, id: string): Promise<ScheduledReplyView> {
  const found = (await view(b, number)).scheduled.find((entry) => entry.id === id)
  if (!found) throw new Error("no scheduled reply")
  return found
}

async function timedJobs(actionId: string) {
  const rows = await db().execute<{ data: { actionId: string; version: number }; start_after: Date }>(
    sql`select data, start_after from pgboss.job where name = ${TIMED_ACTION} and data->>'actionId' = ${actionId} order by created_on`,
  )
  return rows.rows.map((row) => ({ version: row.data.version, startAfter: new Date(row.start_after) }))
}

async function repliesOf(ticketId: string): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(message)
    .where(and(eq(message.ticketId, ticketId), eq(message.direction, "out")))
  return row?.n ?? 0
}

async function statusOf(id: string) {
  return (await db().select({ status: ticket.status }).from(ticket).where(eq(ticket.id, id)))[0]?.status
}

async function outboxOfAction(actionId: string) {
  return db().select().from(outbox).where(eq(outbox.actionId, actionId))
}

async function schedule(b: TestBrowser, number: number, values: Record<string, unknown> = {}) {
  const answer = await b.call("POST", `/api/v1/tickets/${number}/messages`, reply({ sendAt: inHours(2), ...values }))
  expect(answer.status, JSON.stringify(answer.json)).toBe(201)
  return answer.json.scheduled as string
}

describe("a scheduled reply", () => {
  it("is built now, waits for its time, and goes through the send point then; set pending applies only then", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const sendAt = inHours(3)
    const submission = randomUUID()
    const body = reply({ submissionId: submission, sendAt, setPending: true })
    const answer = await agent.call("POST", `/api/v1/tickets/${t.number}/messages`, body)
    expect(answer.status).toBe(201)
    const id = answer.json.scheduled as string
    expect((await agent.call("POST", `/api/v1/tickets/${t.number}/messages`, body)).json).toEqual({ scheduled: id })

    expect(await repliesOf(t.id)).toBe(0)
    expect(await statusOf(t.id)).toBe("new")
    expect(await timedJobs(id)).toEqual([{ version: 1, startAfter: new Date(sendAt) }])
    const shown = await scheduledOf(agent, t.number, id)
    expect(shown).toMatchObject({ state: "scheduled", version: 1, sendAt, editable: true, setPending: true })
    expect(shown.text).toContain(TODA)
    const { b: colleague } = await newAgent(admin, "a.colleague", [org])
    expect((await scheduledOf(colleague, t.number, id)).editable).toBe(false)

    expect(await actions().run(id, 1)).toBe("handed")
    expect(await statusOf(t.id)).toBe("new")
    const [made] = await outboxOfAction(id)
    expect(made).toMatchObject({ state: "pending", actionVersion: 1 })
    const sendJobs = await db().execute<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where name = ${SEND_REPLY} and data->>'messageId' = ${made?.messageId ?? ""}`,
    )
    expect(sendJobs.rows[0]?.n).toBe(1)
    expect(await sender().send(made?.messageId ?? "")).toBe("accepted")
    expect(await statusOf(t.id)).toBe("pending")
    const [pending] = await db()
      .select({ actor: auditLog.actorLabel, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, t.id), eq(auditLog.action, "ticket.status")))
    expect(pending).toEqual({
      actor: "an.agent",
      details: { ticket: t.number, from: "new", to: "pending", via: "reply" },
    })
    expect((await scheduledOf(agent, t.number, id)).state).toBe("done")
    expect((await scheduledOf(agent, t.number, id)).outboxState).toBe("accepted")
    const parsed = await simpleParser(smtp2go.received.at(-1)?.raw ?? Buffer.alloc(0))
    expect(parsed.date?.toISOString()).toBe(new Date(sendAt).toISOString().replace(/\.\d{3}Z$/, ".000Z"))
    expect((await view(agent, t.number)).messages.find((m) => m.id === made?.messageId)?.scheduled).toBe(true)
    expect(await actions().run(id, 1)).toBe("stale")
    expect(await repliesOf(t.id)).toBe(1)
  })

  it("refuses a time that is not ahead, a note, and a change or a cancellation once it ended", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const post = (values: Record<string, unknown>) =>
      agent.call("POST", `/api/v1/tickets/${t.number}/messages`, reply(values))
    expect((await post({ sendAt: inHours(-1) })).json).toEqual({ error: "time_past" })
    expect((await post({ sendAt: inHours(1), kind: "note", from: null, to: [] })).json).toEqual({
      error: "request_invalid",
    })
    expect((await post({ sendAt: "tomorrow" })).json).toEqual({ error: "request_invalid" })
    const id = await schedule(agent, t.number)
    expect(await actions().run(id, 1)).toBe("handed")
    expect((await agent.call("POST", `/api/v1/scheduled/${id}/cancel`)).status).toBe(200)
    const [made] = await outboxOfAction(id)
    expect(await sender().send(made?.messageId ?? "")).toBe("failed")
    expect((await outboxOfAction(id))[0]?.problem).toBe("action_ended")
    expect((await agent.call("POST", `/api/v1/scheduled/${id}/cancel`)).json).toEqual({ error: "scheduled_not_open" })
    const change = await agent.call("PUT", `/api/v1/scheduled/${id}`, { ...reply(), sendAt: inHours(4), version: 1 })
    expect(change.json).toEqual({ error: "scheduled_not_open" })
  })

  it("sets pending only when it goes: a cancel or a failed check at the send point leaves the status", async () => {
    const admin = await firstAdmin()
    const { b: agent, id: agentId } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const cancelled = await schedule(agent, t.number, { setPending: true })
    const refused = await schedule(agent, t.number, { setPending: true })
    expect(await actions().run(cancelled, 1)).toBe("handed")
    expect(await actions().run(refused, 1)).toBe("handed")
    const before = smtp2go.received.length
    expect((await agent.call("POST", `/api/v1/scheduled/${cancelled}/cancel`)).status).toBe(200)
    const [first] = await outboxOfAction(cancelled)
    expect(await sender().send(first?.messageId ?? "")).toBe("failed")
    expect(await statusOf(t.id)).toBe("new")
    await new Organizations(db()).removeMember(org, agentId, { actor: SYSTEM, ipAddress: null })
    const [second] = await outboxOfAction(refused)
    expect(await sender().send(second?.messageId ?? "")).toBe("failed")
    expect((await outboxOfAction(refused))[0]?.problem).toBe("author_not_allowed")
    expect(await scheduledOf(admin, t.number, refused)).toMatchObject({ state: "ended", reason: "author_not_allowed" })
    expect(await statusOf(t.id)).toBe("new")
    expect(smtp2go.received.length).toBe(before)
    const shown = await view(admin, t.number)
    for (const made of [first, second])
      expect(shown.messages.find((m) => m.id === made?.messageId)?.delivery).toMatchObject({
        state: "failed",
        scheduledEnded: true,
      })
    const resend = await admin.call("POST", `/api/v1/messages/${second?.messageId}/resend`)
    expect(resend.json).toEqual({ error: "reply_not_retryable" })
  })

  it("stores the agent's text cleaned, as a reply sent now is: a NUL never reaches the database", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const nul = String.fromCharCode(0)
    const id = await schedule(agent, t.number, { html: `<p>One${nul}two</p>` })
    const shown = await scheduledOf(agent, t.number, id)
    expect(shown.html).not.toContain(nul)
    expect(shown.html).toContain(`One${String.fromCodePoint(0xfffd)}two`)
    const change = { ...reply({ html: `<p>Three${nul}</p>` }), sendAt: inHours(3), version: 1 }
    expect((await agent.call("PUT", `/api/v1/scheduled/${id}`, change)).status).toBe(200)
    expect((await scheduledOf(agent, t.number, id)).html).not.toContain(nul)
  })

  it("refuses a submission ID the other kind took: a lost answer then a note never blocks the scheduled reply", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const post = (values: Record<string, unknown>) =>
      agent.call("POST", `/api/v1/tickets/${t.number}/messages`, reply(values))
    const note = { kind: "note", from: null, to: [], html: "<p>A note</p>" }
    const first = randomUUID()
    expect((await post({ submissionId: first, sendAt: inHours(2) })).status).toBe(201)
    const reused = await post({ submissionId: first, ...note })
    expect(reused.status).toBe(409)
    expect(reused.json).toEqual({ error: "submission_reused" })
    const second = randomUUID()
    expect((await post({ submissionId: second, ...note })).status).toBe(201)
    expect((await post({ submissionId: second, sendAt: inHours(2) })).json).toEqual({ error: "submission_reused" })
    const [action] = await db().select({ id: timedAction.id }).from(timedAction).where(eq(timedAction.ticketId, t.id))
    expect(await actions().run(action?.id ?? "", 1)).toBe("handed")
    expect(await outboxOfAction(action?.id ?? "")).toHaveLength(1)
  })

  it("lets one of a reply sent now and a scheduled reply racing with the same ID through, in either order", async () => {
    const admin = await firstAdmin()
    const { b: agent, id: userId } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const waiting = async () => {
      const rows = await db().execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      )
      return rows.rows[0]?.n ?? 0
    }
    for (const order of [
      ["now", "later"],
      ["later", "now"],
    ] as const) {
      const submissionId = randomUUID()
      let release = () => {}
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      let held = () => {}
      const holding = new Promise<void>((resolve) => {
        held = resolve
      })
      const holder = db().transaction(async (tx) => {
        await tx.execute(sql`select id from ticket where id = ${t.id} for update`)
        held()
        await released
      })
      await holding
      const answers: ReturnType<TestBrowser["call"]>[] = []
      try {
        for (const [index, kind] of order.entries()) {
          const values = kind === "now" ? { submissionId } : { submissionId, sendAt: inHours(2) }
          answers.push(agent.call("POST", `/api/v1/tickets/${t.number}/messages`, reply(values)))
          await vi.waitFor(async () => expect(await waiting()).toBe(index + 1), { timeout: 15_000, interval: 50 })
        }
      } finally {
        release()
      }
      await holder
      const [first, second] = await Promise.all(answers)
      expect(first?.status, order.join()).toBe(201)
      expect(second?.status, order.join()).toBe(409)
      expect(second?.json).toEqual({ error: "submission_reused" })
      const messages = await db()
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.authorUserId, userId), eq(message.submissionId, submissionId)))
      const scheduled = await db()
        .select({ id: timedAction.id })
        .from(timedAction)
        .where(and(eq(timedAction.authorUserId, userId), eq(timedAction.submissionId, submissionId)))
      expect(messages.length + scheduled.length, order.join()).toBe(1)
      expect(scheduled.length, order.join()).toBe(order[0] === "later" ? 1 : 0)
    }
  })
})

describe("changing and cancelling a scheduled reply", () => {
  it("makes a new version: the old version's job does nothing, the new one sends the new text at the new time", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const { b: colleague } = await newAgent(admin, "a.colleague", [org])
    const t = await customerTicket()
    const id = await schedule(agent, t.number)
    const later = inHours(5)
    const changed = { ...reply({ html: "<p>Changed text</p>" }), sendAt: later, version: 1 }
    const { submissionId: _unused, kind: _kind, ...input } = changed
    expect((await colleague.call("PUT", `/api/v1/scheduled/${id}`, input)).json).toEqual({
      error: "scheduled_not_author",
    })
    expect((await agent.call("PUT", `/api/v1/scheduled/${id}`, { ...input, sendAt: inHours(-1) })).json).toEqual({
      error: "time_past",
    })
    expect((await agent.call("PUT", `/api/v1/scheduled/${id}`, input)).status).toBe(200)
    expect((await agent.call("PUT", `/api/v1/scheduled/${id}`, input)).json).toEqual({ error: "scheduled_changed" })
    const shown = await scheduledOf(agent, t.number, id)
    expect(shown).toMatchObject({ version: 2, sendAt: later, state: "scheduled" })
    expect(shown.text).toContain("Changed text")
    expect((await timedJobs(id)).map((job) => job.version)).toEqual([1, 2])

    expect(await actions().run(id, 1)).toBe("stale")
    expect(await outboxOfAction(id)).toEqual([])
    expect(await actions().run(id, 2)).toBe("handed")
    const [made] = await outboxOfAction(id)
    expect(made?.actionVersion).toBe(2)
    expect(await sender().send(made?.messageId ?? "")).toBe("accepted")
    const parsed = await simpleParser(smtp2go.received.at(-1)?.raw ?? Buffer.alloc(0))
    expect(parsed.text).toContain("Changed text")
    const audit = await db()
      .select({ action: auditLog.action, actor: auditLog.actorLabel })
      .from(auditLog)
      .where(eq(auditLog.entityId, id))
      .orderBy(asc(auditLog.id))
    expect(audit).toEqual([
      { action: "message.schedule", actor: "an.agent" },
      { action: "message.schedule_change", actor: "an.agent" },
    ])
  })

  it("after its reply was written (handed): only the new version's text goes, once", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const id = await schedule(agent, t.number, { html: "<p>First text</p>" })
    expect(await actions().run(id, 1)).toBe("handed")
    const [old] = await outboxOfAction(id)
    const oldId = old?.messageId ?? ""
    expect((await scheduledOf(agent, t.number, id)).editable).toBe(true)
    const { submissionId: _unused, kind: _kind, ...changed } = reply({ html: "<p>Changed text</p>" })
    expect(
      (await agent.call("PUT", `/api/v1/scheduled/${id}`, { ...changed, sendAt: inHours(1), version: 1 })).status,
    ).toBe(200)
    expect(await scheduledOf(agent, t.number, id)).toMatchObject({ state: "scheduled", version: 2 })
    const before = smtp2go.received.length

    expect(await sender().send(oldId)).toBe("failed")
    expect((await db().select().from(outbox).where(eq(outbox.messageId, oldId)))[0]?.problem).toBe("action_ended")
    expect(await actions().run(id, 2)).toBe("handed")
    const made = (await outboxOfAction(id)).find((row) => row.actionVersion === 2)
    expect(made?.messageId).not.toBe(oldId)
    expect(await sender().send(made?.messageId ?? "")).toBe("accepted")
    expect(smtp2go.received.length).toBe(before + 1)
    const parsed = await simpleParser(smtp2go.received.at(-1)?.raw ?? Buffer.alloc(0))
    expect(parsed.text).toContain("Changed text")
    expect(parsed.text).not.toContain("First text")

    expect((await agent.call("POST", `/api/v1/messages/${oldId}/resend`)).json).toEqual({
      error: "reply_not_retryable",
    })
    await db().update(outbox).set({ state: "pending", problem: null }).where(eq(outbox.messageId, oldId))
    expect(await sender().send(oldId)).toBe("failed")
    expect(smtp2go.received.length).toBe(before + 1)
    const shown = await view(agent, t.number)
    expect(shown.messages.find((m) => m.id === oldId)?.delivery?.scheduledEnded).toBe(true)
    expect(shown.messages.find((m) => m.id === made?.messageId)?.delivery?.scheduledEnded).toBe(false)
  })

  it("cancelled by any agent of the ticket: its job does nothing, and the view says so", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const { b: colleague } = await newAgent(admin, "a.colleague", [org])
    const { b: outsider } = await newAgent(admin, "an.outsider", [other])
    const t = await customerTicket()
    const id = await schedule(agent, t.number)
    expect((await outsider.call("POST", `/api/v1/scheduled/${id}/cancel`)).status).toBe(404)
    expect((await colleague.call("POST", `/api/v1/scheduled/${id}/cancel`)).status).toBe(200)
    expect(await scheduledOf(agent, t.number, id)).toMatchObject({ state: "cancelled", reason: "agent" })
    expect(await actions().run(id, 1)).toBe("stale")
    expect(await repliesOf(t.id)).toBe(0)
  })
})

describe("a customer reply before a scheduled reply's time", () => {
  it("cancels it in the transaction that attaches the message; the view says so; the agent can write again", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const id = await schedule(agent, t.number)
    await customerAnswers(t)
    expect(await scheduledOf(agent, t.number, id)).toMatchObject({ state: "cancelled", reason: "customer_reply" })
    expect(await actions().run(id, 1)).toBe("stale")
    expect(await repliesOf(t.id)).toBe(0)
    const again = await schedule(agent, t.number)
    expect(await actions().run(again, 1)).toBe("handed")
  })

  it("between its outbox row and the send point ends it there without sending", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const id = await schedule(agent, t.number)
    expect(await actions().run(id, 1)).toBe("handed")
    const [made] = await outboxOfAction(id)
    const before = smtp2go.received.length
    await customerAnswers(t)
    expect(await sender().send(made?.messageId ?? "")).toBe("failed")
    expect(smtp2go.received.length).toBe(before)
    expect((await outboxOfAction(id))[0]?.problem).toBe("customer_reply")
    expect(await scheduledOf(agent, t.number, id)).toMatchObject({ state: "cancelled", reason: "customer_reply" })
    const resend = await agent.call("POST", `/api/v1/messages/${made?.messageId}/resend`)
    expect(resend.json).toEqual({ error: "reply_not_retryable" })
  })

  it("is found by the send point's own check too, by the one definition of a customer reply", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const id = await schedule(agent, t.number)
    expect(await actions().run(id, 1)).toBe("handed")
    const [made] = await outboxOfAction(id)
    await customerAnswers(t)
    await db().update(timedAction).set({ state: "handed", reason: null }).where(eq(timedAction.id, id))
    expect(await sender().send(made?.messageId ?? "")).toBe("failed")
    expect((await outboxOfAction(id))[0]?.problem).toBe("customer_reply")
    expect(await scheduledOf(agent, t.number, id)).toMatchObject({ state: "ended", reason: "customer_reply" })
    const next = await schedule(agent, t.number)
    await db()
      .update(timedAction)
      .set({ createdAt: new Date(Date.now() - 24 * HOUR) })
      .where(eq(timedAction.id, next))
    expect(await actions().run(next, 1)).toBe("customer_reply")
    expect(await outboxOfAction(next)).toEqual([])
  })
})

describe("a crash and a rerun", () => {
  it("a crash after the claim sends nothing and never makes a second message", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const id = await schedule(agent, t.number)
    expect(await actions().run(id, 1)).toBe("handed")
    expect(await repliesOf(t.id)).toBe(1)
    const [made] = await outboxOfAction(id)
    const messageId = made?.messageId ?? ""
    const crash = sender({
      afterClaim: async () => {
        throw new Error("crash")
      },
    })
    await expect(crash.send(messageId)).rejects.toThrow("crash")
    expect(await sender().send(messageId)).toBe("unknown")
    expect(smtp2go.received.filter((entry) => entry.raw.includes(made?.messageIdHeader ?? "-"))).toHaveLength(0)
    expect(await repliesOf(t.id)).toBe(1)
    expect((await scheduledOf(agent, t.number, id)).state).toBe("done")
  })
})

describe("a move and a lost permission before the time", () => {
  it("a move to another organization cancels the scheduled reply in the move's transaction", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "agent.both", [org, other])
    const t = await customerTicket()
    const id = await schedule(agent, t.number)
    const handed = await schedule(agent, t.number)
    expect(await actions().run(handed, 1)).toBe("handed")
    expect(
      (await agent.call("PUT", `/api/v1/tickets/${t.number}/organization`, { organizationId: other })).status,
    ).toBe(200)
    expect(await scheduledOf(agent, t.number, id)).toMatchObject({ state: "cancelled", reason: "move" })
    expect(await scheduledOf(agent, t.number, handed)).toMatchObject({ state: "cancelled", reason: "move" })
    expect(await actions().run(id, 1)).toBe("stale")
    const [made] = await outboxOfAction(handed)
    expect(await sender().send(made?.messageId ?? "")).toBe("failed")
    expect((await outboxOfAction(handed))[0]?.problem).toBe("action_ended")
    const [move] = await db()
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.action, "ticket.move"), eq(auditLog.entityId, t.id)))
    expect(move?.details).toMatchObject({ scheduledCancelled: 2 })
  })

  it("an author who lost access to the organization: the job ends it without sending", async () => {
    const admin = await firstAdmin()
    const { b: agent, id: agentId } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const id = await schedule(agent, t.number)
    await new Organizations(db()).removeMember(org, agentId, { actor: SYSTEM, ipAddress: null })
    expect(await actions().run(id, 1)).toBe("author_not_allowed")
    expect(await outboxOfAction(id)).toEqual([])
    expect(await scheduledOf(admin, t.number, id)).toMatchObject({ state: "ended", reason: "author_not_allowed" })
  })
})

describe("the queue", () => {
  it("keeps a job due in more than pg-boss's 14 days of retention until its time", async () => {
    const at = new Date(Date.now() + 40 * 24 * HOUR)
    const far = await boss.send(SNOOZE_END, { ticketId: randomUUID() }, { startAfter: at })
    const job = await boss.getJobById(SNOOZE_END, far ?? "")
    expect(job?.startAfter.getTime()).toBe(at.getTime())
    expect(job?.keepUntil.getTime()).toBeGreaterThan(at.getTime())
  })

  it("queues again the jobs of a scheduled reply and a snooze left waiting past their time", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const u = await customerTicket("Another question")
    const overdue = await schedule(agent, t.number)
    const ahead = await schedule(agent, t.number)
    await agent.call("PUT", `/api/v1/tickets/${u.number}/status`, { status: "pending" })
    expect((await agent.call("PUT", `/api/v1/tickets/${u.number}/snooze`, { until: inHours(2) })).status).toBe(200)
    const hourAgo = new Date(Date.now() - HOUR)
    await db().update(timedAction).set({ dueAt: hourAgo }).where(eq(timedAction.id, overdue))
    await db().update(ticket).set({ snoozedUntil: hourAgo }).where(eq(ticket.id, u.id))
    await db().execute(sql`delete from pgboss.job where name in (${TIMED_ACTION}, ${SNOOZE_END})`)
    expect((await view(agent, u.number)).ticket).toMatchObject({ snoozedUntil: null, snoozeOverdue: true })

    const send = (name: string, data: object) => boss.send(name, data)
    expect(await requeueOverdue(db(), send)).toEqual({ actions: 1, snoozes: 1 })
    expect((await timedJobs(overdue)).map((job) => job.version)).toEqual([1])
    expect(await timedJobs(ahead)).toEqual([])
    const snoozes = await db().execute<{ data: { ticketId: string } }>(
      sql`select data from pgboss.job where name = ${SNOOZE_END} and data->>'ticketId' = ${u.id}`,
    )
    expect(snoozes.rows).toHaveLength(1)
    expect(await actions().run(overdue, 1)).toBe("handed")
    expect(await snoozeEnded(db(), snoozes.rows[0]?.data.ticketId ?? "")).toBe(true)
    expect(await statusOf(u.id)).toBe("open")
    expect((await view(agent, u.number)).ticket.snoozeOverdue).toBe(false)
    expect(await requeueOverdue(db(), send)).toEqual({ actions: 0, snoozes: 0 })
  })
})

describe("snooze", () => {
  const snooze = (b: TestBrowser, number: number, until: string) =>
    b.call("PUT", `/api/v1/tickets/${number}/snooze`, { until })
  const list = async (b: TestBrowser, status?: string): Promise<number[]> => {
    const answer = await b.call("GET", `/api/v1/tickets${status ? `?status=${status}` : ""}`)
    expect(answer.status).toBe(200)
    return (answer.json as TicketList).tickets.map((entry) => entry.number)
  }
  async function snoozeJobs(ticketId: string) {
    const rows = await db().execute<{ data: { ticketId: string } }>(
      sql`select data from pgboss.job where name = ${SNOOZE_END} and data->>'ticketId' = ${ticketId} order by created_on`,
    )
    return rows.rows.map((row) => row.data.ticketId)
  }
  const timeHasCome = (ticketId: string) =>
    db().update(ticket).set({ snoozedUntil: sql`now() - interval '1 minute'` }).where(eq(ticket.id, ticketId))

  it("takes a ticket out of the default list until its time; a pending ticket then becomes open, audited", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    expect(await list(agent)).toContain(t.number)
    expect((await snooze(agent, t.number, inHours(-1))).json).toEqual({ error: "time_past" })
    const until = inHours(4)
    expect((await snooze(agent, t.number, until)).status).toBe(200)
    expect(await list(agent)).not.toContain(t.number)
    expect(await list(agent, "snoozed")).toEqual([t.number])
    expect((await view(agent, t.number)).ticket.snoozedUntil).toBe(until)
    const summary = (await agent.call("GET", "/api/v1/tickets?status=all")).json as TicketList
    expect(summary.tickets.find((entry) => entry.number === t.number)?.snoozedUntil).toBe(until)

    await agent.call("PUT", `/api/v1/tickets/${t.number}/status`, { status: "pending" })
    const [queued] = await snoozeJobs(t.id)
    expect(await snoozeEnded(db(), queued ?? "")).toBe(false)
    expect(await statusOf(t.id)).toBe("pending")
    expect(await list(agent, "snoozed")).toEqual([t.number])
    expect((await view(agent, t.number)).ticket.snoozedUntil).toBe(until)
    await timeHasCome(t.id)
    expect(await snoozeEnded(db(), queued ?? "")).toBe(true)
    expect(await statusOf(t.id)).toBe("open")
    expect(await list(agent)).toContain(t.number)
    expect((await view(agent, t.number)).ticket.snoozedUntil).toBeNull()
    const audit = await db()
      .select({ action: auditLog.action, actor: auditLog.actorLabel, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, t.id), sql`${auditLog.action} like 'ticket.%'`))
      .orderBy(asc(auditLog.id))
    expect(audit.slice(-3)).toEqual([
      { action: "ticket.status", actor: "an.agent", details: expect.objectContaining({ to: "pending" }) },
      {
        action: "ticket.status",
        actor: "system",
        details: { ticket: t.number, from: "pending", to: "open", via: "snooze" },
      },
      { action: "ticket.unsnooze", actor: "system", details: { ticket: t.number, via: "time" } },
    ])
    expect(await snoozeEnded(db(), queued ?? "")).toBe(false)
  })

  it("leaves a ticket solved meanwhile as it is", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    expect((await snooze(agent, t.number, inHours(2))).status).toBe(200)
    await agent.call("PUT", `/api/v1/tickets/${t.number}/status`, { status: "solved" })
    const [queued] = await snoozeJobs(t.id)
    await timeHasCome(t.id)
    expect(await snoozeEnded(db(), queued ?? "")).toBe(true)
    expect(await statusOf(t.id)).toBe("solved")
  })

  it("is replaced by a newer snooze: the older job does nothing; the agent can also end it by hand", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    expect((await snooze(agent, t.number, inHours(2))).status).toBe(200)
    const later = inHours(6)
    expect((await snooze(agent, t.number, later)).status).toBe(200)
    const [first, second] = await snoozeJobs(t.id)
    expect(await snoozeEnded(db(), first ?? "")).toBe(false)
    expect((await view(agent, t.number)).ticket.snoozedUntil).toBe(later)
    await agent.call("PUT", `/api/v1/tickets/${t.number}/status`, { status: "pending" })
    expect((await agent.call("DELETE", `/api/v1/tickets/${t.number}/snooze`)).status).toBe(200)
    expect((await view(agent, t.number)).ticket.snoozedUntil).toBeNull()
    expect(await statusOf(t.id)).toBe("open")
    expect(await snoozeEnded(db(), second ?? "")).toBe(false)
  })

  it("ends at once when the customer replies", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    await agent.call("PUT", `/api/v1/tickets/${t.number}/status`, { status: "pending" })
    expect((await snooze(agent, t.number, inHours(8))).status).toBe(200)
    await customerAnswers(t)
    expect((await view(agent, t.number)).ticket.snoozedUntil).toBeNull()
    expect(await statusOf(t.id)).toBe("open")
    expect(await list(agent)).toContain(t.number)
    const [queued] = await snoozeJobs(t.id)
    expect(await snoozeEnded(db(), queued ?? "")).toBe(false)
    const [ended] = await db()
      .select({ actor: auditLog.actorLabel, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, t.id), eq(auditLog.action, "ticket.unsnooze")))
    expect(ended).toEqual({ actor: "system", details: { ticket: t.number, via: "customer_reply" } })
  })
})
