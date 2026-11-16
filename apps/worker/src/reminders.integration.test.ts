import { randomUUID } from "node:crypto"
import { SYSTEM } from "@maane/server/audit"
import { auditLog, message, outbox, reminder, ticket, timedAction, waitingPeriod } from "@maane/server/db/schema"
import { applyDeliveryEvent } from "@maane/server/delivery/service"
import { type JobQueue, openJobQueue, TIMED_ACTION } from "@maane/server/jobs/queue"
import { Organizations } from "@maane/server/organizations/service"
import { reminderDueAt } from "@maane/server/reminders/periods"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { createTestApp } from "@maane/server/testing/app"
import { nextIp, TestBrowser, testPassword } from "@maane/server/testing/browser"
import { type SettingKey, type TicketView, userEmail } from "@maane/shared"
import { and, count, desc, eq, sql } from "drizzle-orm"
import { simpleParser } from "mailparser"
import { PgBoss } from "pg-boss"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { requeueOverdue, TimedActions } from "./actions/run.ts"
import { ReplySender } from "./send/sender.ts"
import type { SmtpTimeouts } from "./send/smtp.ts"
import { type StandInClamd, startStandInClamd } from "./testing/clamd.ts"
import { type IntakeHarness, startIntake } from "./testing/intake.ts"
import { fromCodePoints, mime } from "./testing/mime.ts"
import { type StandInSmtp, startStandInSmtp } from "./testing/smtp.ts"

// Plan 4.3 from the API through the timed-action job, intake, the delivery events, and the sender: a waiting period
// starts when a reply that sets the ticket to pending goes to sending, and its reminder goes once, X days later, through
// one rule for every timed action (a second kind of timed action, at most one outbox row per action and version, the
// checks at its time and again at the send point). Every ending stops it, also between its outbox row and the send
// point; a crash and a rerun make no second reminder; timed-recover makes up for a lost job. The clock is the job's:
// the tests run the job as the queue would at its time. Nothing leaves this process: the providers are stand-ins.

const QUICK: SmtpTimeouts = { connection: 2000, greeting: 1500, socket: 3000, setup: 4000, send: 5000 }
const SUPPORT = "support@example.com"
const OTHER = "billing@example.com"
const BOUNCE = "bounce@example.com"
const DANA = "Dana Customer <dana@example.com>"
const HOUR = 3_600_000
const DAY = 24 * HOUR
// A reminder's days are Israel's calendar days: one across a daylight-saving change is an hour shorter or longer.
const DST_SLACK = HOUR + 60_000
const TODA = fromCodePoints(0x5ea, 0x5d5, 0x5d3, 0x5d4)
// "Shalom, we are still waiting for your answer" in Hebrew, then an English line: the email is right to left.
const SHALOM = fromCodePoints(0x5e9, 0x5dc, 0x5d5, 0x5dd)
const WAITING = fromCodePoints(0x5e2, 0x5d3, 0x5d9, 0x5d9, 0x5df, 0x20, 0x5de, 0x5de, 0x5ea, 0x5d9, 0x5e0, 0x5d9, 0x5dd)
const TEMPLATE = `${SHALOM},\n${WAITING}.\n\nOrder 1234 is on hold.`

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

const db = () => h.database.db
const browser = () => new TestBrowser(app.fetch, nextIp())
const settings = () => new Settings(h.database.db, createSettingsCipher([{ version: 1, value: h.cipherKey }]), {})

function sender(
  options: { afterClaim?: (id: string) => Promise<void>; values?: Partial<Record<SettingKey, string>> } = {},
) {
  const { values: overrides, ...hooks } = options
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
    ...overrides,
  }
  const own = new Settings(h.database.db, createSettingsCipher([{ version: 1, value: h.cipherKey }]), values)
  return new ReplySender({
    db: h.database.db,
    settings: own,
    queue: (jobs, name, data, startAfter) => queue.sendIn(jobs, name, data, { startAfter }),
    timeouts: QUICK,
    ...hooks,
  })
}

/** A send point no provider takes anything from: SMTP2GO cannot be logged in to, and no failover is set up. */
const refusing = () => sender({ values: { "smtp2go.password": `${smtp2go.password}x`, "failover.host": "" } })

/** The worker's timed-action job, queueing its send-reply job through pg-boss in the job's own transaction. */
const actions = () =>
  new TimedActions({ db: db(), settings: settings(), queue: (tx, name, data) => boss.send(name, data, { db: tx }) })

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

/** The organization's reminder, set by an admin on its page. */
async function setReminder(admin: TestBrowser, template: string, days: number, organizationId = org) {
  const answer = await admin.call("PUT", `/api/v1/admin/organizations/${organizationId}/reminder`, { template, days })
  expect(answer.status, JSON.stringify(answer.json)).toBe(200)
}

async function customerTicket(subject = "A question") {
  const messageId = `${randomUUID()}@mail.example.com`
  const graphId = h.graph.add(mime({ messageId, subject, from: DANA, to: SUPPORT, text: { content: TODA } }))
  await h.round()
  const found = await h.ticketOf(graphId)
  if (!found) throw new Error("no ticket")
  return { number: found.number, id: found.id, messageId }
}

/** The customer answers the ticket's first message, through intake. */
async function customerAnswers(t: { messageId: string }) {
  h.graph.add(
    mime({ from: DANA, to: SUPPORT, subject: "Re: A question", inReplyTo: t.messageId, text: { content: TODA } }),
  )
  await h.round()
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

/** An agent's reply sent now, and its message's ID. */
async function answer(b: TestBrowser, number: number, values: Record<string, unknown> = {}) {
  const sent = await b.call("POST", `/api/v1/tickets/${number}/messages`, reply(values))
  expect(sent.status, JSON.stringify(sent.json)).toBe(201)
  return sent.json.id as string
}

async function view(b: TestBrowser, number: number): Promise<TicketView> {
  const shown = await b.call("GET", `/api/v1/tickets/${number}`)
  expect(shown.status).toBe(200)
  return shown.json
}

/** The ticket's reminders, newest first. */
async function remindersOf(ticketId: string) {
  return db()
    .select({ action: timedAction, periodId: reminder.periodId })
    .from(timedAction)
    .innerJoin(reminder, eq(reminder.actionId, timedAction.id))
    .where(eq(timedAction.ticketId, ticketId))
    .orderBy(desc(timedAction.createdAt))
}

async function periodsOf(ticketId: string) {
  return db().select().from(waitingPeriod).where(eq(waitingPeriod.ticketId, ticketId)).orderBy(waitingPeriod.startedAt)
}

/** The ticket's one reminder, made by a reply that set it to pending. */
async function onlyReminder(ticketId: string) {
  const rows = await remindersOf(ticketId)
  expect(rows).toHaveLength(1)
  const found = rows[0]
  if (!found) throw new Error("no reminder")
  return found.action
}

async function outboxOfAction(actionId: string) {
  return db().select().from(outbox).where(eq(outbox.actionId, actionId))
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

/** A ticket with a waiting period started by an agent's "Send and set pending", its reply accepted. */
async function waiting(template = TEMPLATE) {
  const admin = await firstAdmin()
  await setReminder(admin, template, 2)
  const { b: agent } = await newAgent(admin, "agent.both", [org, other])
  const t = await customerTicket()
  const started = await answer(agent, t.number, { setPending: true })
  expect(await sender().send(started)).toBe("accepted")
  return { admin, agent, t, started }
}

describe("an organization's reminder", () => {
  it("is set by an admin on the organization's page, within its bounds, and audited", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const shown = await admin.call("GET", `/api/v1/admin/organizations/${org}`)
    // No template by default (no reminders), and a sensible number of days the admin can change.
    expect(shown.json.organization).toMatchObject({ reminderTemplate: "", reminderDays: 3 })
    const put = (body: unknown) => admin.call("PUT", `/api/v1/admin/organizations/${org}/reminder`, body)
    expect((await put({ template: "x", days: 0 })).json).toEqual({ error: "reminder_days_invalid", min: 1, max: 60 })
    expect((await put({ template: "x", days: 61 })).json).toEqual({ error: "reminder_days_invalid", min: 1, max: 60 })
    expect((await put({ template: "x", days: 1.5 })).json).toEqual({ error: "reminder_days_invalid", min: 1, max: 60 })
    expect((await put({ template: "x".repeat(2001), days: 2 })).json).toEqual({
      error: "reminder_template_invalid",
      max: 2000,
    })
    expect((await put({ template: `${TEMPLATE}\r\n\r\n`, days: 5 })).status).toBe(200)
    const saved = await admin.call("GET", `/api/v1/admin/organizations/${org}`)
    expect(saved.json.organization).toMatchObject({ reminderTemplate: TEMPLATE, reminderDays: 5 })
    const [audit] = await db()
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.action, "organization.reminder"), eq(auditLog.entityId, org)))
    expect(audit?.details).toEqual({ days: 5, template: "set" })
    // Admins only.
    expect(
      (await agent.call("PUT", `/api/v1/admin/organizations/${org}/reminder`, { template: "", days: 2 })).status,
    ).toBe(403)
  })
})

describe("a reminder's time", () => {
  // Israel's clocks change on Friday 2026-03-27 (to UTC+3) and on Sunday 2026-10-25 (back to UTC+2).
  const dueOf = async (from: string, days: number) =>
    db().transaction(async (tx) => {
      // A connection in another time zone: the days are still Israel's.
      await tx.execute(sql`set local time zone 'UTC'`)
      const rows = await tx.execute<{ epoch: string; local: string }>(
        sql`select extract(epoch from due)::bigint::text as epoch,
                   to_char(due at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') as local
            from (select ${reminderDueAt(days, sql`${from}::timestamptz`)} as due) as t`,
      )
      const row = rows.rows[0]
      return { at: new Date(Number(row?.epoch) * 1000), local: row?.local }
    })

  it("is X days later at the same local time, across the change to summer time", async () => {
    // Thursday noon in Israel (UTC+2), three days on: Sunday noon (UTC+3), 71 hours later.
    const from = "2026-03-26T10:00:00Z"
    const due = await dueOf(from, 3)
    expect(due.local).toBe("2026-03-29 12:00")
    expect(due.at.getTime() - new Date(from).getTime()).toBe(71 * HOUR)
  })

  it("is X days later at the same local time, across the change back to winter time", async () => {
    // Friday noon in Israel (UTC+3), three days on: Monday noon (UTC+2), 73 hours later.
    const from = "2026-10-23T09:00:00Z"
    const due = await dueOf(from, 3)
    expect(due.local).toBe("2026-10-26 12:00")
    expect(due.at.getTime() - new Date(from).getTime()).toBe(73 * HOUR)
  })
})

describe("a reminder", () => {
  it("is sent once, X days after a reply set the ticket to pending, as the organization, through the send point", async () => {
    const { agent, t, started } = await waiting()
    // The period started with the reply, and its reminder waits two days, its job queued for that same time.
    const [period] = await periodsOf(t.id)
    expect(period).toMatchObject({ origin: "maane", messageId: started, endedAt: null })
    const due = await onlyReminder(t.id)
    expect(due).toMatchObject({ kind: "reminder", state: "scheduled", version: 1, authorUserId: null })
    expect(Math.abs(due.dueAt.getTime() - (Date.now() + 2 * DAY))).toBeLessThan(DST_SLACK)
    expect(await timedJobs(due.id)).toEqual([{ version: 1, startAfter: due.dueAt }])
    expect((await view(agent, t.number)).reminder).toEqual({
      id: due.id,
      dueAt: due.dueAt.toISOString(),
      state: "scheduled",
    })

    // Its time: the job writes the reminder, and the send point sends it.
    expect(await actions().run(due.id, 1)).toBe("handed")
    const [made] = await outboxOfAction(due.id)
    expect(made).toMatchObject({ state: "pending", actionVersion: 1 })
    expect(await sender().send(made?.messageId ?? "")).toBe("accepted")
    expect(await statusOf(t.id)).toBe("pending")
    // An automated message: it neither changes the status nor starts a new period.
    expect(await periodsOf(t.id)).toHaveLength(1)
    expect(await remindersOf(t.id)).toHaveLength(1)
    const shown = await view(agent, t.number)
    expect(shown.reminder).toBeNull()
    const sent = shown.messages.find((m) => m.id === made?.messageId)
    expect(sent).toMatchObject({ direction: "out", reminder: true, scheduled: false, author: null })
    expect(sent?.delivery).toMatchObject({ state: "accepted", reminder: true })
    const [audit] = await db()
      .select({ actor: auditLog.actorLabel, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.action, "message.reminder"), eq(auditLog.entityId, made?.messageId ?? "")))
    expect(audit?.details).toMatchObject({ ticket: t.number, from: SUPPORT, recipients: ["dana@example.com"] })

    // Once: its job again (a queue retry) does nothing.
    expect(await actions().run(due.id, 1)).toBe("stale")
    expect(await repliesOf(t.id)).toBe(2)
  })

  it("is the 3.2 email: Auto-Submitted, the organization's name, the reference code, the thread, right to left", async () => {
    const { t, started } = await waiting()
    const due = await onlyReminder(t.id)
    expect(await actions().run(due.id, 1)).toBe("handed")
    const [made] = await outboxOfAction(due.id)
    expect(await sender().send(made?.messageId ?? "")).toBe("accepted")
    const [agentReply] = await db().select().from(message).where(eq(message.id, started))
    const [row] = await db().select({ code: ticket.referenceCode }).from(ticket).where(eq(ticket.id, t.id))

    const raws = smtp2go.received.map((entry) => entry.raw)
    const own = raws.find((raw) => raw.includes(made?.messageIdHeader ?? "-"))
    const theirs = raws.find((raw) => raw.includes(agentReply?.messageIdHeader ?? "-"))
    const parsed = await simpleParser(own ?? Buffer.alloc(0))
    expect(parsed.headers.get("auto-submitted")).toBe("auto-generated")
    // An agent's reply never carries it (requirements 2.3).
    expect((await simpleParser(theirs ?? Buffer.alloc(0))).headers.get("auto-submitted")).toBeUndefined()
    // From the ticket's address, with the organization's name alone; to the ticket's customer.
    expect(parsed.from?.value).toEqual([{ address: SUPPORT, name: "Example Support" }])
    expect(parsed.to && !Array.isArray(parsed.to) ? parsed.to.value : []).toEqual([
      { address: "dana@example.com", name: "Dana Customer" },
    ])
    expect(parsed.subject).toBe(`Re: A question [#${t.number}]`)
    expect(parsed.inReplyTo).toBe(`<${agentReply?.messageIdHeader}>`)
    expect(parsed.references).toContain(`<${agentReply?.messageIdHeader}>`)
    // The template is the message, with the reference code, in the 3.2 layout: right to left for a Hebrew text.
    const html = typeof parsed.html === "string" ? parsed.html : ""
    expect(html).toMatch(/<html[^>]*dir="rtl"/)
    expect(html).toContain(row?.code ?? "-")
    expect(html).toMatch(new RegExp(`<div dir="rtl"[^>]*>${SHALOM},</div>`))
    expect(html).toMatch(/<div dir="ltr"[^>]*>Order 1234 is on hold.<\/div>/)
    expect(parsed.text).toContain(WAITING)
    expect(parsed.text).toContain(row?.code ?? "-")
    // The conversation keeps the template as its text, under the organization's name.
    const [stored] = await db()
      .select()
      .from(message)
      .where(eq(message.id, made?.messageId ?? ""))
    expect(stored).toMatchObject({ authorUserId: null, textBody: TEMPLATE, fromAddress: SUPPORT })
  })

  it("starts for a scheduled reply when it goes to sending, not when it is scheduled", async () => {
    const admin = await firstAdmin()
    await setReminder(admin, TEMPLATE, 2)
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const scheduled = await agent.call(
      "POST",
      `/api/v1/tickets/${t.number}/messages`,
      reply({ setPending: true, sendAt: new Date(Date.now() + HOUR).toISOString() }),
    )
    const id = scheduled.json.scheduled as string
    expect(await periodsOf(t.id)).toEqual([])
    expect(await actions().run(id, 1)).toBe("handed")
    expect(await periodsOf(t.id)).toEqual([])
    const [made] = await outboxOfAction(id)
    expect(await sender().send(made?.messageId ?? "")).toBe("accepted")
    // In the claim that handed it to sending, with "Send and set pending": the period and its reminder's job.
    const [period] = await periodsOf(t.id)
    expect(period).toMatchObject({ origin: "maane", messageId: made?.messageId, endedAt: null })
    const due = await onlyReminder(t.id)
    expect(await timedJobs(due.id)).toEqual([{ version: 1, startAfter: due.dueAt }])
  })
})

describe("the end of a waiting period stops its reminder", () => {
  const cases: [string, (c: Awaited<ReturnType<typeof waiting>>) => Promise<void>, string][] = [
    ["a customer reply", async ({ t }) => customerAnswers(t), "customer_reply"],
    [
      "a status change away from pending",
      async ({ agent, t }) => {
        const changed = await agent.call("PUT", `/api/v1/tickets/${t.number}/status`, { status: "on_hold" })
        expect(changed.status).toBe(200)
      },
      "status_change",
    ],
    [
      "a new agent reply",
      async ({ agent, t }) => {
        await answer(agent, t.number)
      },
      "agent_reply",
    ],
    [
      "a bounce on the reply that started the period",
      async ({ started }) => {
        await db().transaction((tx) =>
          applyDeliveryEvent(
            tx,
            { messageId: started, acceptedBefore: new Date(Date.now() + HOUR) },
            { recipient: "dana@example.com", status: "hard_bounce", at: new Date(), detail: null, source: "report" },
          ),
        )
      },
      "delivery_failed",
    ],
  ]

  it.each(cases)("%s", async (_name, end, reason) => {
    const c = await waiting()
    const due = await onlyReminder(c.t.id)
    await end(c)
    // In the ending's own transaction: the period ends, and its reminder is cancelled with the same reason.
    const [period] = await periodsOf(c.t.id)
    expect(period).toMatchObject({ endReason: reason })
    expect(period?.endedAt).not.toBeNull()
    const [after] = await db().select().from(timedAction).where(eq(timedAction.id, due.id))
    expect(after).toMatchObject({ state: "cancelled", reason })
    expect((await view(c.agent, c.t.number)).reminder).toBeNull()
    // Its job at its time does nothing.
    const before = smtp2go.received.length
    expect(await actions().run(due.id, 1)).toBe("stale")
    expect(await outboxOfAction(due.id)).toEqual([])
    expect(smtp2go.received.length).toBe(before)
    // None of these starts a new period by itself.
    expect((await periodsOf(c.t.id)).filter((row) => row.endedAt === null)).toEqual([])
  })

  it("only a bounce on the reply that started it: a bounce on an earlier reply leaves it", async () => {
    const admin = await firstAdmin()
    await setReminder(admin, TEMPLATE, 2)
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const earlier = await answer(agent, t.number)
    expect(await sender().send(earlier)).toBe("accepted")
    const started = await answer(agent, t.number, { setPending: true })
    expect(await sender().send(started)).toBe("accepted")
    await db().transaction((tx) =>
      applyDeliveryEvent(
        tx,
        { messageId: earlier, acceptedBefore: new Date(Date.now() + HOUR) },
        { recipient: "dana@example.com", status: "hard_bounce", at: new Date(), detail: null, source: "report" },
      ),
    )
    expect((await onlyReminder(t.id)).state).toBe("scheduled")
    expect((await periodsOf(t.id)).at(-1)?.endedAt).toBeNull()
  })

  it("a scheduled reply with a plain Send ends it when it goes to sending, not when it is scheduled", async () => {
    const { agent, t } = await waiting()
    const due = await onlyReminder(t.id)
    const scheduled = await agent.call(
      "POST",
      `/api/v1/tickets/${t.number}/messages`,
      reply({ sendAt: new Date(Date.now() + HOUR).toISOString() }),
    )
    const id = scheduled.json.scheduled as string
    expect(await actions().run(id, 1)).toBe("handed")
    expect((await onlyReminder(t.id)).state).toBe("scheduled")
    const [made] = await outboxOfAction(id)
    expect(await sender().send(made?.messageId ?? "")).toBe("accepted")
    // In the claim that handed it to sending: the period ends, and no new one starts (a plain Send).
    expect((await db().select().from(timedAction).where(eq(timedAction.id, due.id)))[0]).toMatchObject({
      state: "cancelled",
      reason: "agent_reply",
    })
    expect((await periodsOf(t.id)).map((row) => row.endReason)).toEqual(["agent_reply"])
    expect(await statusOf(t.id)).toBe("pending")
  })

  it("a new reply that sets pending again ends the old period and starts a new one with its own reminder", async () => {
    const { agent, t } = await waiting()
    const first = await onlyReminder(t.id)
    const again = await answer(agent, t.number, { setPending: true })
    const periods = await periodsOf(t.id)
    expect(periods.map((row) => row.endReason)).toEqual(["agent_reply", null])
    expect(periods[1]?.messageId).toBe(again)
    const [newest, oldest] = await remindersOf(t.id)
    expect(oldest?.action).toMatchObject({ id: first.id, state: "cancelled", reason: "agent_reply" })
    expect(newest?.action.state).toBe("scheduled")
    expect(newest?.periodId).toBe(periods[1]?.id)
  })
})

describe("a move to another organization during a waiting period", () => {
  const OTHER_TEMPLATE = "We are still waiting for your answer about the invoice."

  async function move(agent: TestBrowser, number: number) {
    const moved = await agent.call("PUT", `/api/v1/tickets/${number}/organization`, { organizationId: other })
    expect(moved.status, JSON.stringify(moved.json)).toBe(200)
  }

  /** The old reminder, cancelled by the move, and its job at its time does nothing. */
  async function oldEnded(actionId: string) {
    const [after] = await db().select().from(timedAction).where(eq(timedAction.id, actionId))
    expect(after).toMatchObject({ state: "cancelled", reason: "move" })
    const before = smtp2go.received.length
    expect(await actions().run(actionId, 1)).toBe("stale")
    expect(await outboxOfAction(actionId)).toEqual([])
    expect(smtp2go.received.length).toBe(before)
  }

  it("ends the old reminder and starts a new one with the new organization's days and template", async () => {
    const { admin, agent, t, started } = await waiting()
    await setReminder(admin, OTHER_TEMPLATE, 5, other)
    const old = await onlyReminder(t.id)
    await move(agent, t.number)

    // In the move's transaction: the old period ends, and a new one goes on at once for the same reply.
    const periods = await periodsOf(t.id)
    expect(periods).toMatchObject([
      { endReason: "move", messageId: started },
      { origin: "maane", messageId: started, endedAt: null, endReason: null },
    ])
    const [newest] = await remindersOf(t.id)
    const fresh = newest?.action
    expect(newest?.periodId).toBe(periods[1]?.id)
    expect(fresh).toMatchObject({ kind: "reminder", state: "scheduled", version: 1 })
    // The new organization's days, counted from the move, with its job queued for that same time.
    expect(Math.abs((fresh?.dueAt.getTime() ?? 0) - (Date.now() + 5 * DAY))).toBeLessThan(DST_SLACK)
    expect(await timedJobs(fresh?.id ?? "")).toEqual([{ version: 1, startAfter: fresh?.dueAt }])
    expect((await view(agent, t.number)).reminder?.id).toBe(fresh?.id)
    // The audit counts the scheduled replies the move cancelled, never the reminder.
    const [audit] = await db()
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.action, "ticket.move"), eq(auditLog.entityId, t.id)))
    expect(audit?.details).not.toHaveProperty("scheduledCancelled")
    await oldEnded(old.id)

    // At its time it goes as the new organization: its template, read then, from its address, under its name.
    await setReminder(admin, `${OTHER_TEMPLATE} Thank you.`, 5, other)
    expect(await actions().run(fresh?.id ?? "", 1)).toBe("handed")
    const [made] = await outboxOfAction(fresh?.id ?? "")
    expect(await sender().send(made?.messageId ?? "")).toBe("accepted")
    const raw = smtp2go.received.map((entry) => entry.raw).find((entry) => entry.includes(made?.messageIdHeader ?? "-"))
    const parsed = await simpleParser(raw ?? Buffer.alloc(0))
    expect(parsed.from?.value).toEqual([{ address: OTHER, name: "Example Other" }])
    expect(parsed.text).toContain(`${OTHER_TEMPLATE} Thank you.`)
    expect(parsed.headers.get("auto-submitted")).toBe("auto-generated")
  })

  it("to an organization without a template: the old reminder ends and none is scheduled", async () => {
    const { agent, t, started } = await waiting()
    const old = await onlyReminder(t.id)
    await move(agent, t.number)
    // The waiting goes on under the new organization, with no reminder.
    expect(await periodsOf(t.id)).toMatchObject([
      { endReason: "move" },
      { origin: "maane", messageId: started, endedAt: null },
    ])
    expect((await remindersOf(t.id)).map((row) => row.action.id)).toEqual([old.id])
    expect((await view(agent, t.number)).reminder).toBeNull()
    const jobs = await db().execute<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where name = ${TIMED_ACTION}`,
    )
    expect(jobs.rows[0]?.n).toBe(1)
    await oldEnded(old.id)
  })

  it("of an imported period: it only ends, and nothing is scheduled", async () => {
    const { admin, agent, t, started } = await waiting()
    await setReminder(admin, OTHER_TEMPLATE, 5, other)
    const old = await onlyReminder(t.id)
    await db().update(waitingPeriod).set({ origin: "import" }).where(eq(waitingPeriod.messageId, started))
    await move(agent, t.number)
    expect(await periodsOf(t.id)).toMatchObject([{ origin: "import", endReason: "move" }])
    expect((await remindersOf(t.id)).map((row) => row.action.id)).toEqual([old.id])
    await oldEnded(old.id)
  })
})

describe("a sent reminder in a later reply", () => {
  it("is quoted under the organization's name, as the customer saw it", async () => {
    const { agent, t } = await waiting()
    const due = await onlyReminder(t.id)
    expect(await actions().run(due.id, 1)).toBe("handed")
    const [made] = await outboxOfAction(due.id)
    expect(await sender().send(made?.messageId ?? "")).toBe("accepted")
    const later = await answer(agent, t.number)
    expect(await sender().send(later)).toBe("accepted")
    const [row] = await db().select().from(message).where(eq(message.id, later))
    const raw = smtp2go.received.map((entry) => entry.raw).find((r) => r.includes(row?.messageIdHeader ?? "-"))
    const parsed = await simpleParser(raw ?? Buffer.alloc(0))
    // The newest quoted message is the reminder: its attribution line ("On {date}, {name} wrote:" in the default
    // language) and its quoted block name the organization; the agent's earlier reply names its agent with it.
    expect(parsed.text).toMatch(/,\s+Example Support\s/)
    expect(parsed.text).toMatch(/^> Example Support \|/m)
    expect(parsed.text).toMatch(/^> agent\.both \(Example Support\) \|/m)
    expect(parsed.text).not.toContain(`> ${SUPPORT} |`)
  })
})

describe("the period ending between the reminder's outbox row and the send point", () => {
  it("ends it at the send point without sending: Send again is never offered and is refused", async () => {
    const { agent, t } = await waiting()
    const due = await onlyReminder(t.id)
    expect(await actions().run(due.id, 1)).toBe("handed")
    const [made] = await outboxOfAction(due.id)
    const before = smtp2go.received.length
    await customerAnswers(t)
    expect(await sender().send(made?.messageId ?? "")).toBe("failed")
    expect(smtp2go.received.length).toBe(before)
    expect((await outboxOfAction(due.id))[0]?.problem).toBe("reminder_ended")
    const shown = (await view(agent, t.number)).messages.find((m) => m.id === made?.messageId)
    expect(shown?.delivery).toMatchObject({ state: "failed", problem: "reminder_ended", reminder: true })
    const resend = await agent.call("POST", `/api/v1/messages/${made?.messageId}/resend`)
    expect(resend.json).toEqual({ error: "reply_not_retryable" })
  })

  it("is found by the send point's own checks too: the ticket no longer pending, a bounce, the customer's reply", async () => {
    const { t, started } = await waiting()
    const due = await onlyReminder(t.id)
    expect(await actions().run(due.id, 1)).toBe("handed")
    const [made] = await outboxOfAction(due.id)
    // As if no ending had cancelled it: the claim reads the ticket, the delivery, and intake's records itself.
    await db().update(ticket).set({ status: "open" }).where(eq(ticket.id, t.id))
    expect(await sender().send(made?.messageId ?? "")).toBe("failed")
    expect((await db().select().from(timedAction).where(eq(timedAction.id, due.id)))[0]).toMatchObject({
      state: "ended",
      reason: "status_change",
    })

    // Each case: what happened first, then the reminder as if nothing had ended it (pending, its period open, handed).
    const check = async (prepare: () => Promise<void>, reason: string) => {
      await prepare()
      await db().update(ticket).set({ status: "pending" }).where(eq(ticket.id, t.id))
      await db().update(waitingPeriod).set({ endedAt: null, endReason: null }).where(eq(waitingPeriod.ticketId, t.id))
      await db().update(timedAction).set({ state: "handed", reason: null }).where(eq(timedAction.id, due.id))
      await db().update(outbox).set({ state: "pending", problem: null }).where(eq(outbox.actionId, due.id))
      expect(await sender().send(made?.messageId ?? "")).toBe("failed")
      expect((await db().select().from(timedAction).where(eq(timedAction.id, due.id)))[0]).toMatchObject({
        state: "ended",
        reason,
      })
    }
    await check(async () => {
      await db().execute(
        sql`update outbox_recipient set delivery = 'rejected', delivery_at = now() where message_id = ${started}`,
      )
    }, "delivery_failed")
    await check(async () => {
      await db().execute(
        sql`update outbox_recipient set delivery = null, delivery_at = null where message_id = ${started}`,
      )
      await customerAnswers(t)
    }, "customer_reply")
    expect(smtp2go.received.filter((entry) => entry.raw.includes(made?.messageIdHeader ?? "-"))).toHaveLength(0)
  })
})

describe("a crash and a rerun", () => {
  it("find the reminder's outbox row and never make a second reminder", async () => {
    const { agent, t } = await waiting()
    const due = await onlyReminder(t.id)
    expect(await actions().run(due.id, 1)).toBe("handed")
    // A rerun that finds the action as if its state had not been saved finds the reminder its version made.
    await db().update(timedAction).set({ state: "scheduled" }).where(eq(timedAction.id, due.id))
    expect(await actions().run(due.id, 1)).toBe("stale")
    await db().update(timedAction).set({ state: "handed" }).where(eq(timedAction.id, due.id))
    expect(await repliesOf(t.id)).toBe(2)
    // The send point stops after its claim (a crash): its rerun turns the recipients unknown and sends nothing.
    const [made] = await outboxOfAction(due.id)
    const messageId = made?.messageId ?? ""
    const crash = sender({
      afterClaim: async () => {
        throw new Error("crash")
      },
    })
    await expect(crash.send(messageId)).rejects.toThrow("crash")
    expect(await sender().send(messageId)).toBe("unknown")
    expect(smtp2go.received.filter((entry) => entry.raw.includes(made?.messageIdHeader ?? "-"))).toHaveLength(0)
    expect(await repliesOf(t.id)).toBe(2)
    // A reminder whose fate is unknown may have reached the customer: the view offers no Send again (its period is still
    // open), and the server refuses it.
    const shown = (await view(agent, t.number)).messages.find((m) => m.id === messageId)
    expect(shown?.delivery).toMatchObject({ state: "unknown", reminder: true, reminderResend: false })
    expect((await periodsOf(t.id)).at(-1)?.endedAt).toBeNull()
    expect((await agent.call("POST", `/api/v1/messages/${messageId}/resend`)).json).toEqual({
      error: "reply_not_retryable",
    })
  })
})

describe("Send again of a reminder that no provider took", () => {
  /** A reminder that passed its checks at the send point, and then failed for certain: nothing reached the customer. */
  async function failedReminder() {
    const c = await waiting()
    const due = await onlyReminder(c.t.id)
    expect(await actions().run(due.id, 1)).toBe("handed")
    const [made] = await outboxOfAction(due.id)
    const id = made?.messageId ?? ""
    expect(await refusing().send(id)).toBe("failed")
    expect((await db().select().from(timedAction).where(eq(timedAction.id, due.id)))[0]?.state).toBe("done")
    return { ...c, due, header: made?.messageIdHeader ?? "-", id }
  }
  const resend = (b: TestBrowser, id: string) => b.call("POST", `/api/v1/messages/${id}/resend`)
  const delivered = (header: string) => smtp2go.received.filter((entry) => entry.raw.includes(header))
  const deliveryShown = async (b: TestBrowser, number: number, id: string) =>
    (await view(b, number)).messages.find((m) => m.id === id)?.delivery

  it("sends it again, once, while its waiting period is still open", async () => {
    const { agent, t, header, id } = await failedReminder()
    expect(await deliveryShown(agent, t.number, id)).toMatchObject({
      state: "failed",
      problem: "unreachable",
      reminder: true,
      reminderResend: true,
    })
    expect((await resend(agent, id)).status).toBe(200)
    expect(await sender().send(id)).toBe("accepted")
    expect(delivered(header)).toHaveLength(1)
    // Accepted now: never again, and still one reminder and one period.
    expect((await resend(agent, id)).json).toEqual({ error: "reply_not_retryable" })
    expect(await remindersOf(t.id)).toHaveLength(1)
    expect(await periodsOf(t.id)).toHaveLength(1)
    expect(await statusOf(t.id)).toBe("pending")
  })

  it("refuses it once its waiting period ended", async () => {
    const { agent, t, header, id } = await failedReminder()
    await customerAnswers(t)
    expect(await deliveryShown(agent, t.number, id)).toMatchObject({ state: "failed", reminderResend: false })
    expect((await resend(agent, id)).json).toEqual({ error: "reply_not_retryable" })
    expect(await sender().send(id)).toBe("failed")
    expect(delivered(header)).toHaveLength(0)
  })

  it("is checked again by the claim: the period ending after Send again was accepted sends nothing", async () => {
    const { agent, t, due, header, id } = await failedReminder()
    expect((await resend(agent, id)).status).toBe(200)
    const changed = await agent.call("PUT", `/api/v1/tickets/${t.number}/status`, { status: "on_hold" })
    expect(changed.status).toBe(200)
    expect(await sender().send(id)).toBe("failed")
    expect((await outboxOfAction(due.id))[0]?.problem).toBe("reminder_ended")
    expect(delivered(header)).toHaveLength(0)
    // The action went to the send point once; only its row failed.
    expect((await db().select().from(timedAction).where(eq(timedAction.id, due.id)))[0]?.state).toBe("done")
    expect(await deliveryShown(agent, t.number, id)).toMatchObject({ problem: "reminder_ended", reminderResend: false })
  })
})

describe("timed-recover", () => {
  it("queues again a reminder whose job was lost, and it goes once", async () => {
    const { t } = await waiting()
    const due = await onlyReminder(t.id)
    await db()
      .update(timedAction)
      .set({ dueAt: new Date(Date.now() - HOUR) })
      .where(eq(timedAction.id, due.id))
    await db().execute(sql`delete from pgboss.job where name = ${TIMED_ACTION}`)
    const send = (name: string, data: object) => boss.send(name, data)
    expect(await requeueOverdue(db(), send)).toEqual({ actions: 1, snoozes: 0 })
    expect((await timedJobs(due.id)).map((job) => job.version)).toEqual([1])
    expect(await actions().run(due.id, 1)).toBe("handed")
    // The lost job turning up after all, and the recovery running again: no second reminder.
    expect(await actions().run(due.id, 1)).toBe("stale")
    expect(await requeueOverdue(db(), send)).toEqual({ actions: 0, snoozes: 0 })
    const [made] = await outboxOfAction(due.id)
    expect(await sender().send(made?.messageId ?? "")).toBe("accepted")
    expect(await outboxOfAction(due.id)).toHaveLength(1)
    expect(smtp2go.received.filter((entry) => entry.raw.includes(made?.messageIdHeader ?? "-"))).toHaveLength(1)
  })
})

describe("no reminder", () => {
  it("for an organization without a template: the period is kept, no reminder is made", async () => {
    const admin = await firstAdmin()
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    const started = await answer(agent, t.number, { setPending: true })
    expect(await sender().send(started)).toBe("accepted")
    expect(await periodsOf(t.id)).toMatchObject([{ origin: "maane", messageId: started, endedAt: null }])
    expect(await remindersOf(t.id)).toEqual([])
    expect((await view(agent, t.number)).reminder).toBeNull()
    const jobs = await db().execute<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where name = ${TIMED_ACTION}`,
    )
    expect(jobs.rows[0]?.n).toBe(0)
  })

  it("when the template was removed before its time: its job ends it without writing", async () => {
    const { admin, t } = await waiting()
    const due = await onlyReminder(t.id)
    await setReminder(admin, "", 2)
    expect(await actions().run(due.id, 1)).toBe("no_template")
    expect(await outboxOfAction(due.id)).toEqual([])
  })

  it("for a plain Send, an internal note, or a reply that does not leave the ticket pending", async () => {
    const admin = await firstAdmin()
    await setReminder(admin, TEMPLATE, 2)
    const { b: agent } = await newAgent(admin, "an.agent", [org])
    const t = await customerTicket()
    await answer(agent, t.number)
    await answer(agent, t.number, { kind: "note", from: null, to: [] })
    expect(await periodsOf(t.id)).toEqual([])
    expect(await remindersOf(t.id)).toEqual([])
  })

  it("for a period the import made: only Maane's own periods send", async () => {
    const { t, started } = await waiting()
    const due = await onlyReminder(t.id)
    // As phase 5 will mark one: the same period, recorded as imported.
    await db().update(waitingPeriod).set({ origin: "import" }).where(eq(waitingPeriod.messageId, started))
    expect(await actions().run(due.id, 1)).toBe("imported")
    expect(await outboxOfAction(due.id)).toEqual([])
  })

  it("while intake listens: its job ends it without writing", async () => {
    const { t } = await waiting()
    const due = await onlyReminder(t.id)
    await h.mode("listening")
    expect(await actions().run(due.id, 1)).toBe("listening")
    expect(await outboxOfAction(due.id)).toEqual([])
  })
})
