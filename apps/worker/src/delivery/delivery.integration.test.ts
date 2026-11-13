import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { auditLog, deliveryPoll, outbox, outboxRecipient } from "@maane/server/db/schema"
import { type JobQueue, openJobQueue } from "@maane/server/jobs/queue"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { createTestApp } from "@maane/server/testing/app"
import { nextIp, TEST_ORIGIN, TestBrowser, testPassword } from "@maane/server/testing/browser"
import { MIGRATIONS_DIR } from "@maane/server/testing/db"
import type { SettingKey, TicketView, WebhookSecretsView } from "@maane/shared"
import { eq, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ReplySender, type ReplySenderOptions } from "../send/sender.ts"
import type { SmtpTimeouts } from "../send/smtp.ts"
import { type StandInClamd, startStandInClamd } from "../testing/clamd.ts"
import { type IntakeHarness, startIntake } from "../testing/intake.ts"
import { fromCodePoints, mime } from "../testing/mime.ts"
import { type StandInSmtp, startStandInSmtp } from "../testing/smtp.ts"
import { type StandInSmtp2goApi, startStandInSmtp2goApi } from "../testing/smtp2go-api.ts"
import { ActivityPoll, POLL_OVERLAP_MS } from "./poll.ts"

// Delivery status and bounces (plan 3.3), end to end: replies written through the server's API and sent by the worker's
// sender to the stand-in SMTP servers (SMTP2GO's answers with its queue ID), SMTP2GO's webhook through the server app
// with secrets generated on the Settings API, its activity search through a stand-in API, and failover bounces through
// the stand-in Graph into intake. Nothing leaves this process.

const QUICK: SmtpTimeouts = { connection: 2000, greeting: 1500, socket: 3000, setup: 4000, send: 5000 }
const SUPPORT = "support@example.com"
const BOUNCE = "bounce@example.com"
const TODA = fromCodePoints(0x5ea, 0x5d5, 0x5d3, 0x5d4)

let clamd: StandInClamd
let smtp2go: StandInSmtp
let failover: StandInSmtp
let api: StandInSmtp2goApi
let h: IntakeHarness
let app: ReturnType<typeof createTestApp>
let queue: JobQueue
const password = testPassword()

beforeAll(async () => {
  clamd = await startStandInClamd()
  smtp2go = await startStandInSmtp()
  failover = await startStandInSmtp({ secure: true, acceptAll: true })
  api = await startStandInSmtp2goApi()
})
afterAll(async () => {
  await clamd.close()
  await smtp2go.close()
  await failover.close()
  await api.close()
})
beforeEach(async () => {
  h = await startIntake(clamd)
  await h.organization("Example Support", [{ value: SUPPORT, isDefault: true }])
  await h.mode("live")
  queue = await openJobQueue(h.database.url)
  app = createTestApp(h.database, {}, queue, h.dir)
  await app.ready
  api.events.length = 0
  api.requests.length = 0
  api.failWith = null
})
afterEach(async () => {
  await queue.stop()
  await app.close()
  await h.close()
})

/** The worker's settings: the stand-ins' addresses and credentials, given to this process only. */
function workerSettings(values: Partial<Record<SettingKey, string>> = {}, without: SettingKey[] = []) {
  const overrides: Partial<Record<SettingKey, string>> = {
    "smtp2go.host": smtp2go.host,
    "smtp2go.port": String(smtp2go.port),
    "smtp2go.user": smtp2go.user,
    "smtp2go.password": smtp2go.password,
    "smtp2go.apiKey": api.apiKey,
    "failover.host": failover.host,
    "failover.port": String(failover.port),
    "failover.security": "tls",
    "failover.user": failover.user,
    "failover.password": failover.password,
    "mail.bounceAddress": BOUNCE,
    ...values,
  }
  for (const key of without) delete overrides[key]
  return new Settings(h.database.db, createSettingsCipher([{ version: 1, value: h.cipherKey }]), overrides)
}

const sender = (
  values: Partial<Record<SettingKey, string>> = {},
  hooks: Pick<ReplySenderOptions, "afterClaim" | "afterSend" | "afterRecord"> = {},
) => new ReplySender({ db: h.database.db, settings: workerSettings(values), timeouts: QUICK, ...hooks })

/** SMTP2GO cannot be logged in to, so the failover takes the reply (from the bounce address). */
const viaFailover = () => ({ "smtp2go.password": `${smtp2go.password}x` })

let admin: TestBrowser
async function firstAdmin() {
  admin = new TestBrowser(app.fetch, nextIp())
  expect((await admin.setup("first.admin", password)).status).toBe(200)
  await admin.enroll(password)
  return admin
}

/** A customer's message through intake: its ticket's number. */
async function customerTicket(): Promise<number> {
  const graphId = h.graph.add(mime({ from: "Dana Customer <dana@example.com>", to: SUPPORT, text: { content: TODA } }))
  await h.round()
  const found = await h.ticketOf(graphId)
  if (!found) throw new Error("no ticket")
  return found.number
}

/** A reply written through the API and sent by the worker. Returns its ID and its own Message-ID. */
async function sentReply(
  number: number,
  to: string[],
  settings: Partial<Record<SettingKey, string>> = {},
): Promise<{ id: string; messageId: string }> {
  const written = await admin.call("POST", `/api/v1/tickets/${number}/messages`, {
    submissionId: randomUUID(),
    kind: "reply",
    from: SUPPORT,
    to: to.map((address) => ({ address, name: null })),
    cc: [],
    html: `<p dir="auto">${TODA}</p>`,
    uploads: [],
    parts: [],
  })
  expect(written.status, JSON.stringify(written.json)).toBe(201)
  const id = written.json.id as string
  await sender(settings).send(id)
  const [row] = await h.database.db
    .select({ messageId: outbox.messageIdHeader })
    .from(outbox)
    .where(eq(outbox.messageId, id))
  return { id, messageId: row?.messageId ?? "" }
}

/** SMTP2GO's queue ID for a recipient, as the stand-in answered it and the sender kept it. */
async function queueIdOf(id: string, address: string): Promise<string> {
  const rows = await h.database.db.select().from(outboxRecipient).where(eq(outboxRecipient.messageId, id))
  const row = rows.find((entry) => entry.address === address)
  expect(row?.providerId).toMatch(/^[0-9a-f]{16}$/)
  return row?.providerId ?? ""
}

async function view(number: number): Promise<TicketView> {
  const answer = await admin.call("GET", `/api/v1/tickets/${number}`)
  expect(answer.status).toBe(200)
  return answer.json
}

const recipientsOf = async (number: number, id: string) =>
  (await view(number)).messages.find((m) => m.id === id)?.delivery?.recipients ?? []

/** Generates the webhook's secrets on the Settings API, as an admin. */
async function webhookSecrets(): Promise<WebhookSecretsView & { path: string }> {
  const made = await admin.call("POST", "/api/v1/settings/smtp2go/webhook")
  expect(made.status).toBe(200)
  const view = made.json as WebhookSecretsView
  return { ...view, path: new URL(view.url).pathname }
}

/** A webhook request as SMTP2GO sends one: JSON or a form, with its Authorization header. */
function hook(path: string, body: Record<string, string>, authorization?: string, form = false) {
  const headers: Record<string, string> = {
    "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
  }
  if (authorization !== undefined) headers.authorization = authorization
  return app.fetch(
    new Request(`${TEST_ORIGIN}${path}`, {
      method: "POST",
      headers,
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    }),
  )
}

const event = (values: { event: string; email_id: string; rcpt: string; time: string; bounce?: string }) => ({
  ...values,
  sender: SUPPORT,
  subject: "A question",
  message: values.event === "delivered" ? "" : "550 5.1.1 mailbox unavailable",
})

describe("the SMTP2GO webhook", () => {
  it("is refused without both secrets: an unknown path as a path that does not exist, a wrong header with 401", async () => {
    await firstAdmin()
    // Before any secret exists, nothing answers.
    const none = await hook("/hooks/smtp2go/anything", {}, "Bearer anything")
    expect(none.status).toBe(404)
    const { path, token, url } = await webhookSecrets()
    expect(url.startsWith(`${TEST_ORIGIN}/hooks/smtp2go/`)).toBe(true)
    expect(path.slice("/hooks/smtp2go/".length)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const nowhere = await (await hook("/hooks/nowhere/at-all", {}, `Bearer ${token}`)).text()
    const wrongPath = await hook(`${path}x`, {}, `Bearer ${token}`)
    expect(wrongPath.status).toBe(404)
    expect(await wrongPath.text()).toBe(nowhere)
    expect((await hook(path, {})).status).toBe(401)
    expect((await hook(path, {}, `Bearer ${token}x`)).status).toBe(401)
    expect((await hook(path, {}, token)).status).toBe(401)
    expect((await hook(path, {}, `Basic ${token}`)).status).toBe(401)
    expect((await hook(path, { event: "processed" }, `Bearer ${token}`)).status).toBe(200)

    // Shown once: the Settings API says only that they are set, and refuses them as typed values.
    const settings = await admin.call("GET", "/api/v1/settings")
    for (const key of ["smtp2go.webhookPath", "smtp2go.webhookToken"])
      expect(settings.json.settings.find((s: { key: string }) => s.key === key)).toMatchObject({
        value: null,
        secret: true,
        set: true,
      })
    expect(JSON.stringify(settings.json)).not.toContain(token)
    const typed = await admin.call("PUT", "/api/v1/settings", { "smtp2go.webhookToken": "a".repeat(43) })
    expect(typed.status).toBe(400)
    // The audit rows say they changed, never their values.
    const audit = JSON.stringify(await h.database.db.select().from(auditLog))
    expect(audit).toContain("smtp2go.webhookPath")
    expect(audit).not.toContain(token)
    expect(audit).not.toContain(path.slice("/hooks/smtp2go/".length))

    // Replaced: the old ones stop at once.
    const next = await webhookSecrets()
    expect((await hook(path, { event: "processed" }, `Bearer ${token}`)).status).toBe(404)
    expect((await hook(next.path, { event: "processed" }, `Bearer ${token}`)).status).toBe(401)
    expect((await hook(next.path, { event: "processed" }, `Bearer ${next.token}`)).status).toBe(200)
  })

  it("never logs its path, its header, or its body, also when its handler fails", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const reply = await sentReply(number, ["dana@example.com"])
    const providerId = await queueIdOf(reply.id, "dana@example.com")
    const { path, token } = await webhookSecrets()
    const secret = path.slice("/hooks/smtp2go/".length)
    const body = event({
      event: "delivered",
      email_id: providerId,
      rcpt: "dana@example.com",
      time: "2026-11-13T10:00:00Z",
    })

    const lines: string[] = []
    const capture = (chunk: unknown) => {
      lines.push(String(chunk))
      return true
    }
    const out = vi.spyOn(process.stdout, "write").mockImplementation(capture)
    const err = vi.spyOn(process.stderr, "write").mockImplementation(capture)
    let failed: Response
    let refused: Response
    try {
      // The handler fails inside its transaction: the table it writes is gone for a moment.
      await h.database.db.execute(sql`alter table outbox_recipient rename to outbox_recipient_away`)
      failed = await hook(path, body, `Bearer ${token}`)
      await h.database.db.execute(sql`alter table outbox_recipient_away rename to outbox_recipient`)
      refused = await hook(path, body, `Bearer ${token}x`)
    } finally {
      out.mockRestore()
      err.mockRestore()
    }
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: "internal" })
    expect(refused.status).toBe(401)
    const log = lines.join("")
    // The failure was logged, with the path hidden.
    expect(log).toContain('"message":"request failed"')
    expect(log).toContain('"path":"/hooks/[hidden]"')
    expect(log).toContain("the SMTP2GO webhook refused a request without its Authorization header")
    for (const value of [secret, token, providerId, "dana@example.com", "mailbox unavailable"])
      expect(log, value).not.toContain(value)
  })

  it("keeps the newest event per recipient: duplicates, late and reordered events change nothing", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const reply = await sentReply(number, ["dana@example.com"])
    const providerId = await queueIdOf(reply.id, "dana@example.com")
    const { path, token } = await webhookSecrets()
    const send = (values: Parameters<typeof event>[0], form = false) =>
      hook(path, event(values), `Bearer ${token}`, form)
    const rcpt = "dana@example.com"

    // A soft bounce, then the delivery (as a form, SMTP2GO's default).
    expect(
      (await send({ event: "bounce", bounce: "soft", email_id: providerId, rcpt, time: "2026-11-13T10:00:00Z" }))
        .status,
    ).toBe(200)
    expect(await recipientsOf(number, reply.id)).toMatchObject([{ delivery: "soft_bounce" }])
    expect((await view(number)).ticket.reviewFlags).toContain("delivery_failed")
    expect(
      (await send({ event: "delivered", email_id: providerId, rcpt, time: "2026-11-13 10:05:00" }, true)).status,
    ).toBe(200)
    expect(await recipientsOf(number, reply.id)).toMatchObject([
      { delivery: "delivered", deliveryAt: "2026-11-13T10:05:00.000Z", deliveryDetail: null },
    ])
    expect((await view(number)).ticket.reviewFlags).not.toContain("delivery_failed")
    // The same soft bounce again (a retry), and an older one arriving late: neither overwrites the delivery.
    await send({ event: "bounce", bounce: "soft", email_id: providerId, rcpt, time: "2026-11-13T10:00:00Z" })
    await send({ event: "bounce", bounce: "soft", email_id: providerId, rcpt, time: "2026-11-13T09:59:00Z" })
    await send({ event: "delivered", email_id: providerId, rcpt, time: "2026-11-13T10:05:00Z" })
    expect(await recipientsOf(number, reply.id)).toMatchObject([
      { delivery: "delivered", deliveryAt: "2026-11-13T10:05:00.000Z" },
    ])
    // A newer spam report does, and flags the ticket.
    await send({ event: "spam", email_id: providerId, rcpt, time: "2026-11-14T08:00:00Z" })
    expect(await recipientsOf(number, reply.id)).toMatchObject([
      { delivery: "spam", deliveryDetail: "550 5.1.1 mailbox unavailable" },
    ])
    expect((await view(number)).ticket.reviewFlags).toContain("delivery_failed")
    const [row] = await h.database.db.select().from(outboxRecipient).where(eq(outboxRecipient.messageId, reply.id))
    expect(row).toMatchObject({ state: "accepted", deliverySource: "webhook" })
  })

  it("drops an event for an unknown ID, another recipient, an event it does not read, or a time it cannot read", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const reply = await sentReply(number, ["dana@example.com"])
    const providerId = await queueIdOf(reply.id, "dana@example.com")
    const { path, token } = await webhookSecrets()
    const rcpt = "dana@example.com"
    for (const values of [
      { event: "bounce", email_id: "unknown-id", rcpt, time: "2026-11-13T10:00:00Z" },
      { event: "bounce", email_id: providerId, rcpt: "ron@example.com", time: "2026-11-13T10:00:00Z" },
      { event: "open", email_id: providerId, rcpt, time: "2026-11-13T10:00:00Z" },
      { event: "bounce", email_id: providerId, rcpt, time: "yesterday" },
    ]) {
      const answer = await hook(path, event(values), `Bearer ${token}`)
      expect(answer.status, JSON.stringify(values)).toBe(200)
    }
    expect((await hook(path, {}, `Bearer ${token}`)).status).toBe(200)
    expect(
      (
        await app.fetch(
          new Request(`${TEST_ORIGIN}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: "{not json",
          }),
        )
      ).status,
    ).toBe(400)
    expect(await recipientsOf(number, reply.id)).toMatchObject([{ delivery: null, deliveryAt: null }])
    expect((await view(number)).ticket.reviewFlags).not.toContain("delivery_failed")
  })
})

describe("the ticket's delivery flag", () => {
  it("is set by a bounce, cleared by a later accepted reply to the same address, and not set again by an old bounce", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const { path, token } = await webhookSecrets()
    const first = await sentReply(number, ["dana@example.com"])
    const firstId = await queueIdOf(first.id, "dana@example.com")
    const bounce = (providerId: string, time: string) =>
      hook(
        path,
        event({ event: "bounce", bounce: "hard", email_id: providerId, rcpt: "dana@example.com", time }),
        `Bearer ${token}`,
      )

    await bounce(firstId, "2026-11-13T10:00:00Z")
    expect((await view(number)).ticket.reviewFlags).toContain("delivery_failed")
    // The list shows it too.
    const list = await admin.call("GET", "/api/v1/tickets")
    expect(list.json.tickets[0].reviewFlags).toContain("delivery_failed")

    // The agent writes again and the reply is accepted: the flag goes.
    const second = await sentReply(number, ["dana@example.com"])
    expect((await view(number)).ticket.reviewFlags).not.toContain("delivery_failed")
    // A late, newer bounce of the first reply does not bring it back.
    await bounce(firstId, "2026-11-13T12:00:00Z")
    expect(await recipientsOf(number, first.id)).toMatchObject([{ delivery: "hard_bounce" }])
    expect((await view(number)).ticket.reviewFlags).not.toContain("delivery_failed")
    // The second reply's own bounce does.
    await bounce(await queueIdOf(second.id, "dana@example.com"), "2026-11-13T13:00:00Z")
    expect((await view(number)).ticket.reviewFlags).toContain("delivery_failed")
  })
})

describe("the activity poll", () => {
  it("reads SMTP2GO's activity over an overlapping window from a cursor that survives a restart", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const reply = await sentReply(number, ["dana@example.com", "ron@example.com"])
    const dana = await queueIdOf(reply.id, "dana@example.com")
    const ron = await queueIdOf(reply.id, "ron@example.com")
    const [accepted] = await h.database.db
      .select({ at: outboxRecipient.updatedAt })
      .from(outboxRecipient)
      .where(eq(outboxRecipient.messageId, reply.id))
    const sentAt = accepted?.at.getTime() ?? 0
    const at = (minutes: number) => new Date(sentAt + minutes * 60_000)
    const iso = (minutes: number) =>
      at(minutes)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z")
    const poll = (minutes: number) =>
      new ActivityPoll({ db: h.database.db, settings: workerSettings(), baseUrl: api.baseUrl, now: () => at(minutes) })

    api.events.push(
      { event: "delivered", email_id: dana, recipient: "dana@example.com", date: iso(1) },
      { event: "soft-bounced", email_id: ron, recipient: "ron@example.com", date: iso(2), reason: "mailbox full" },
      // An event of a message Maane never sent: dropped.
      { event: "hard-bounced", email_id: "someone-else", recipient: "dana@example.com", date: iso(3) },
    )
    const first = await poll(10).run()
    expect(first).toMatchObject({ state: "done", events: 3, applied: 2 })
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0]).toMatchObject({
      authorized: true,
      body: {
        end_date: iso(10),
        event_types: ["delivered", "soft-bounced", "hard-bounced", "rejected", "spam"],
      },
    })
    // The first window starts an overlap before the oldest recipient still waiting for a final status.
    const start = Date.parse(String(api.requests[0]?.body.start_date))
    expect(Math.abs(start - (sentAt - POLL_OVERLAP_MS))).toBeLessThanOrEqual(1000)
    expect(await recipientsOf(number, reply.id)).toMatchObject([
      { address: "dana@example.com", delivery: "delivered" },
      { address: "ron@example.com", delivery: "soft_bounce", deliveryDetail: "mailbox full" },
    ])
    const [cursor] = await h.database.db.select().from(deliveryPoll)
    expect(cursor?.until.toISOString()).toBe(at(10).toISOString())

    // A new process (a restart): it starts from the stored cursor, an overlap earlier, and reads a page at a time.
    api.events.push({ event: "delivered", email_id: ron, recipient: "ron@example.com", date: iso(95) })
    const second = await poll(100).run()
    expect(second).toMatchObject({ state: "done", applied: 1 })
    expect(api.requests[1]?.body.start_date).toBe(
      new Date(at(10).getTime() - POLL_OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, "Z"),
    )
    expect(await recipientsOf(number, reply.id)).toMatchObject([{ delivery: "delivered" }, { delivery: "delivered" }])

    // Every recipient has a final status now: the poll asks nothing.
    expect(await poll(110).run()).toMatchObject({ state: "nothing_pending" })
    expect(api.requests).toHaveLength(2)
  })

  it("keeps its cursor when a page fails, and asks nothing without an API key", async () => {
    await firstAdmin()
    const number = await customerTicket()
    await sentReply(number, ["dana@example.com"])
    const keyless = new ActivityPoll({
      db: h.database.db,
      settings: workerSettings({}, ["smtp2go.apiKey"]),
      baseUrl: api.baseUrl,
    })
    expect((await keyless.run()).state).toBe("not_configured")
    expect(api.requests).toHaveLength(0)
    api.failWith = 503
    const failing = new ActivityPoll({ db: h.database.db, settings: workerSettings(), baseUrl: api.baseUrl })
    await expect(failing.run()).rejects.toMatchObject({ name: "ActivityError", status: 503 })
    expect(await h.database.db.select().from(deliveryPoll)).toEqual([])
    // A wrong key is refused by the stand-in, which accepts only the run's.
    api.failWith = null
    const wrong = new ActivityPoll({
      db: h.database.db,
      settings: workerSettings({ "smtp2go.apiKey": `${api.apiKey}x` }),
      baseUrl: api.baseUrl,
    })
    await expect(wrong.run()).rejects.toMatchObject({ status: 401 })
    expect(api.requests.at(-1)?.authorized).toBe(false)
  })
})

/** A delivery status notification (RFC 3464) from the failover's mail system to the bounce address. */
function deliveryReport(original: string, groups: { address: string; action: string; status: string }[]) {
  const fields = [
    "Reporting-MTA: dns; mx.example.com",
    ...groups.map((g) => `\r\nFinal-Recipient: rfc822; ${g.address}\r\nAction: ${g.action}\r\nStatus: ${g.status}`),
  ].join("\r\n")
  return mime({
    from: "Mail Delivery System <MAILER-DAEMON@example.com>",
    to: BOUNCE,
    subject: "Undelivered Mail Returned to Sender",
    report: {
      type: "delivery-status",
      parts: [
        { contentType: "text/plain", body: "This is the mail system. Your message could not be delivered." },
        { contentType: "message/delivery-status", body: fields },
        {
          contentType: "text/rfc822-headers",
          body: `Message-ID: <${original}>\r\nFrom: ${SUPPORT}\r\nSubject: Re: A question`,
        },
      ],
    },
  })
}

describe("failover bounces in the intake mailbox", () => {
  it("bounces only the recipients a delivery report says failed, and flags the ticket", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const reply = await sentReply(number, ["dana@example.com", "ron@example.com"], viaFailover())
    expect(await recipientsOf(number, reply.id)).toMatchObject([
      { state: "accepted", provider: "failover" },
      { state: "accepted", provider: "failover" },
    ])
    const graphId = h.graph.add(
      deliveryReport(reply.messageId, [
        { address: "dana@example.com", action: "failed", status: "5.1.1" },
        { address: "ron@example.com", action: "delayed", status: "4.4.1" },
      ]),
    )
    await h.round()
    expect(await recipientsOf(number, reply.id)).toMatchObject([
      { address: "dana@example.com", delivery: "hard_bounce", deliveryDetail: "5.1.1" },
      { address: "ron@example.com", delivery: null },
    ])
    expect((await view(number)).ticket.reviewFlags).toContain("delivery_failed")
    const report = await h.messageOf(graphId)
    expect(report.deliveryReport).toEqual([
      { address: "dana@example.com", action: "failed", status: "5.1.1" },
      { address: "ron@example.com", action: "delayed", status: "4.4.1" },
    ])
    // Automated mail: it opened nothing, and its record names the reply it is about.
    expect(await h.recordOf(graphId)).toMatchObject({ outcome: "automated", matchedMessageId: reply.id })
    expect(await h.tickets()).toHaveLength(1)
  })

  it("records a report that names no recipient of the reply on the reply, and changes no recipient", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const reply = await sentReply(number, ["dana@example.com"], viaFailover())
    h.graph.add(
      deliveryReport(reply.messageId, [{ address: "someone.else@example.com", action: "failed", status: "5.1.1" }]),
    )
    await h.round()
    const delivery = (await view(number)).messages.find((m) => m.id === reply.id)?.delivery
    expect(delivery).toMatchObject({
      unmatchedDelivery: expect.objectContaining({ source: "report" }),
      recipients: [{ delivery: null }],
    })
    expect((await view(number)).ticket.reviewFlags).not.toContain("delivery_failed")
  })

  it("never takes a read receipt for a bounce", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const reply = await sentReply(number, ["dana@example.com"], viaFailover())
    h.graph.add(
      mime({
        from: "Dana Customer <dana@example.com>",
        to: SUPPORT,
        subject: "Read: A question",
        report: {
          type: "disposition-notification",
          parts: [
            { contentType: "text/plain", body: "Your message was displayed." },
            {
              contentType: "message/disposition-notification",
              body: `Final-Recipient: rfc822; dana@example.com\r\nOriginal-Message-ID: <${reply.messageId}>\r\nDisposition: manual-action/MDN-sent-manually; displayed`,
            },
          ],
        },
      }),
    )
    await h.round()
    const delivery = (await view(number)).messages.find((m) => m.id === reply.id)?.delivery
    expect(delivery).toMatchObject({ unmatchedDelivery: null, recipients: [{ delivery: null }] })
    expect((await view(number)).ticket.reviewFlags).not.toContain("delivery_failed")
  })

  it("bounces only an accepted recipient: a report about an unknown one is recorded on the reply and flags nothing", async () => {
    await firstAdmin()
    const number = await customerTicket()
    // SMTP2GO takes the data and drops the connection before its final reply: unknown, never sent again by itself.
    const reply = await sentReply(number, ["drop.dana@example.com"], { "failover.host": "" })
    expect(await recipientsOf(number, reply.id)).toMatchObject([{ state: "unknown" }])
    // A report names the unknown recipient: it is kept on the reply, and the recipient keeps no status.
    const bounced = (status: string) =>
      deliveryReport(reply.messageId, [{ address: "drop.dana@example.com", action: "failed", status }])
    h.graph.add(bounced("5.1.1"))
    await h.round()
    expect((await view(number)).messages.find((m) => m.id === reply.id)?.delivery).toMatchObject({
      unmatchedDelivery: expect.objectContaining({ source: "report" }),
      recipients: [{ state: "unknown", delivery: null }],
    })
    // The agent sends it again and the failover takes it: the earlier attempt's report flags nothing.
    expect((await admin.call("POST", `/api/v1/messages/${reply.id}/resend`)).status).toBe(200)
    expect(await sender(viaFailover()).send(reply.id)).toBe("accepted")
    expect(await recipientsOf(number, reply.id)).toMatchObject([
      { state: "accepted", provider: "failover", delivery: null },
    ])
    expect((await view(number)).ticket.reviewFlags).not.toContain("delivery_failed")
    // A report that comes after the accepted send bounces it.
    h.graph.add(bounced("5.2.2"))
    await h.round()
    expect(await recipientsOf(number, reply.id)).toMatchObject([{ delivery: "hard_bounce", deliveryDetail: "5.2.2" }])
    expect((await view(number)).ticket.reviewFlags).toContain("delivery_failed")
  })
})

describe("review of 3.3", () => {
  /** Send again through the failover, which takes it. */
  const resendViaFailover = async (id: string) => {
    expect((await admin.call("POST", `/api/v1/messages/${id}/resend`)).status).toBe(200)
    expect(await sender(viaFailover()).send(id)).toBe("accepted")
  }
  const flagged = async (number: number) => (await view(number)).ticket.reviewFlags.includes("delivery_failed")

  it("D1: the send accepted last decides the flag, in either order of the replies", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const address = "drop.dana@example.com"
    // A, written first: SMTP2GO drops the connection after the data, so its fate is unknown.
    const a = await sentReply(number, [address], { "failover.host": "" })
    // B, written later, goes through the failover, and its report bounces it: flagged.
    const b = await sentReply(number, [address], viaFailover())
    h.graph.add(deliveryReport(b.messageId, [{ address, action: "failed", status: "5.1.1" }]))
    await h.round()
    expect(await flagged(number)).toBe(true)
    // A is sent again and accepted after B: A, written first, is now the send accepted last, and the flag goes.
    await resendViaFailover(a.id)
    expect(await flagged(number)).toBe(false)
    // A's own bounce brings it back, though B was written later.
    h.graph.add(deliveryReport(a.messageId, [{ address, action: "failed", status: "5.2.2" }]))
    await h.round()
    expect(await recipientsOf(number, a.id)).toMatchObject([{ delivery: "hard_bounce", deliveryDetail: "5.2.2" }])
    expect(await flagged(number)).toBe(true)
  })

  it("D2: a report received before a Send again was accepted changes neither the recipient nor the flag", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const address = "drop.dana@example.com"
    const reply = await sentReply(number, [address], { "failover.host": "" })
    // The report reaches the mailbox and is stored (stage one) ...
    h.graph.add(deliveryReport(reply.messageId, [{ address, action: "failed", status: "5.1.1" }]))
    await h.sync.run()
    // ... the agent sends again and the failover accepts it ...
    await resendViaFailover(reply.id)
    // ... and only then is the report processed.
    await h.processor.run()
    expect((await view(number)).messages.find((m) => m.id === reply.id)?.delivery).toMatchObject({
      unmatchedDelivery: expect.objectContaining({ source: "report" }),
      recipients: [{ state: "accepted", delivery: null }],
    })
    expect(await flagged(number)).toBe(false)
  })

  it("D3: the poll goes on past its page limit from SMTP2GO's continue token in the next run", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const reply = await sentReply(number, ["dana@example.com"])
    const dana = await queueIdOf(reply.id, "dana@example.com")
    const [row] = await h.database.db.select().from(outboxRecipient).where(eq(outboxRecipient.messageId, reply.id))
    const sentAt = row?.acceptedAt?.getTime() ?? 0
    const iso = (minutes: number) => new Date(sentAt + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z")
    // Four events of other mail first, then the one Maane needs: on the third page of two.
    for (let i = 0; i < 4; i++)
      api.events.push({ event: "delivered", email_id: `other-${i}`, recipient: "x@example.com", date: iso(1) })
    api.events.push({ event: "delivered", email_id: dana, recipient: "dana@example.com", date: iso(2) })
    const poll = (minutes: number) =>
      new ActivityPoll({
        db: h.database.db,
        settings: workerSettings(),
        baseUrl: api.baseUrl,
        now: () => new Date(sentAt + minutes * 60_000),
        pageSize: 2,
        pagesMax: 2,
      })
    expect(await poll(10).run()).toMatchObject({ state: "partial", events: 4, applied: 0 })
    const [kept] = await h.database.db.select().from(deliveryPoll)
    expect(kept?.continueToken).toBeTruthy()
    // A new process goes on from the kept page, with the same window.
    expect(await poll(20).run()).toMatchObject({ state: "done", events: 1, applied: 1 })
    expect(api.requests).toHaveLength(3)
    expect(api.requests[2]?.body).toMatchObject({
      continue_token: kept?.continueToken,
      start_date: api.requests[0]?.body.start_date,
      end_date: iso(10),
    })
    expect(await recipientsOf(number, reply.id)).toMatchObject([{ delivery: "delivered" }])
    const [done] = await h.database.db.select().from(deliveryPoll)
    expect(done).toMatchObject({ continueToken: null, windowStart: null, windowEnd: null })
    expect(done?.until.toISOString()).toBe(new Date(sentAt + 10 * 60_000).toISOString())
  })

  it("D4: a webhook event without a known queue ID finds its recipient by Maane's Message-ID after one attempt", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const address = "drop.dana@example.com"
    const reply = await sentReply(number, [address], { "failover.host": "" })
    // SMTP2GO kept the message and gave it a queue ID Maane never heard.
    const queueId = smtp2go.received.at(-1)?.queueId ?? ""
    const { path, token } = await webhookSecrets()
    const answer = await hook(
      path,
      {
        ...event({ event: "delivered", email_id: queueId, rcpt: address, time: "2026-11-13T10:00:00Z" }),
        "message-id": `<${reply.messageId}>`,
      },
      `Bearer ${token}`,
    )
    expect(answer.status).toBe(200)
    // The status shows beside the recipient; whether it was sent stays the agent's to decide.
    expect((await view(number)).messages.find((m) => m.id === reply.id)?.delivery).toMatchObject({
      state: "unknown",
      unmatchedDelivery: null,
      recipients: [{ state: "unknown", delivery: "delivered" }],
    })
  })

  it("D4: an event that two attempts could have caused is recorded on the reply, unmatched", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const address = "drop.dana@example.com"
    const reply = await sentReply(number, [address], { "failover.host": "" })
    // Sent again, and dropped again: both attempts may have reached the recipient.
    expect((await admin.call("POST", `/api/v1/messages/${reply.id}/resend`)).status).toBe(200)
    expect(await sender({ "failover.host": "" }).send(reply.id)).toBe("unknown")
    const { path, token } = await webhookSecrets()
    const answer = await hook(
      path,
      {
        ...event({ event: "bounce", email_id: "never-stored", rcpt: address, time: "2026-11-13T10:00:00Z" }),
        "message-id": reply.messageId,
      },
      `Bearer ${token}`,
    )
    expect(answer.status).toBe(200)
    // What the event said is kept for a person to read.
    expect((await view(number)).messages.find((m) => m.id === reply.id)?.delivery).toMatchObject({
      unmatchedDelivery: {
        source: "webhook",
        status: "hard_bounce",
        at: "2026-11-13T10:00:00.000Z",
        recipient: address,
        messageId: reply.messageId,
      },
      recipients: [{ state: "unknown", delivery: null }],
    })
    expect(await flagged(number)).toBe(false)
    // An event naming a Message-ID Maane never sent is dropped and records nothing.
    const other = await sentReply(number, ["ron@example.com"])
    await hook(
      path,
      {
        ...event({ event: "bounce", email_id: "never-stored", rcpt: "ron@example.com", time: "2026-11-13T10:00:00Z" }),
        "message-id": "someone-else@example.com",
      },
      `Bearer ${token}`,
    )
    expect((await view(number)).messages.find((m) => m.id === other.id)?.delivery?.unmatchedDelivery).toBeNull()
  })

  it("D5: the migration fills the queue ID and the acceptance of replies sent before the upgrade", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const reply = await sentReply(number, ["dana@example.com"])
    const queueId = await queueIdOf(reply.id, "dana@example.com")
    // As a row sent before 0010: the final reply is stored, the new columns are empty.
    await h.database.db
      .update(outboxRecipient)
      .set({ providerId: null, acceptedAt: null, possibleSends: 0 })
      .where(eq(outboxRecipient.messageId, reply.id))
    // The backfill's statements on the recipients (its last one reads a column 0013 drops, so it cannot run again).
    const file = readFileSync(join(MIGRATIONS_DIR, "0012_delivery_backfill.sql"), "utf8")
    for (const statement of file.split("--> statement-breakpoint"))
      if (statement.includes('"outbox_recipient"')) await h.database.db.execute(sql.raw(statement))
    const [row] = await h.database.db.select().from(outboxRecipient).where(eq(outboxRecipient.messageId, reply.id))
    expect(row?.providerId).toBe(queueId)
    expect(row?.acceptedAt?.toISOString()).toBe(row?.updatedAt.toISOString())
    expect(row?.possibleSends).toBe(1)
  })
})

describe("review of 3.3, round 2", () => {
  const crash = () => {
    throw new Error("the run stops here")
  }
  /** A reply written through the API, not sent yet. */
  async function written(number: number, to: string[]): Promise<{ id: string; messageId: string }> {
    const answer = await admin.call("POST", `/api/v1/tickets/${number}/messages`, {
      submissionId: randomUUID(),
      kind: "reply",
      from: SUPPORT,
      to: to.map((address) => ({ address, name: null })),
      cc: [],
      html: `<p dir="auto">${TODA}</p>`,
      uploads: [],
      parts: [],
    })
    expect(answer.status).toBe(201)
    const [row] = await h.database.db
      .select({ messageId: outbox.messageIdHeader })
      .from(outbox)
      .where(eq(outbox.messageId, answer.json.id))
    return { id: answer.json.id as string, messageId: row?.messageId ?? "" }
  }
  const possibleSends = async (id: string) =>
    (await h.database.db.select().from(outboxRecipient).where(eq(outboxRecipient.messageId, id))).map(
      (row) => row.possibleSends,
    )

  it("D6: a run that stops after SMTP2GO took the data and before its answer was saved still counts its attempt", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const reply = await written(number, ["dana@example.com"])
    // SMTP2GO accepts the data; the run stops before it saves the answer, so the queue ID is never stored.
    await expect(sender({ "failover.host": "" }, { afterSend: async () => crash() }).send(reply.id)).rejects.toThrow()
    expect(await possibleSends(reply.id)).toEqual([1])
    const { path, token } = await webhookSecrets()
    const answer = await hook(
      path,
      {
        ...event({
          event: "delivered",
          email_id: smtp2go.received.at(-1)?.queueId ?? "",
          rcpt: "dana@example.com",
          time: "2026-11-13T10:00:00Z",
        }),
        "message-id": reply.messageId,
      },
      `Bearer ${token}`,
    )
    expect(answer.status).toBe(200)
    expect((await view(number)).messages.find((m) => m.id === reply.id)?.delivery).toMatchObject({
      unmatchedDelivery: null,
      recipients: [{ delivery: "delivered" }],
    })
  })

  it("D6: once Send again claims a second attempt, an event by Message-ID is unmatched", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const address = "drop.dana@example.com"
    const reply = await sentReply(number, [address], { "failover.host": "" })
    expect(await possibleSends(reply.id)).toEqual([1])
    const { path, token } = await webhookSecrets()
    expect((await admin.call("POST", `/api/v1/messages/${reply.id}/resend`)).status).toBe(200)
    // The second attempt is claimed; while it may already be on its way, an event naming the Message-ID arrives.
    let during: Response | null = null
    const second = sender(
      { "failover.host": "" },
      {
        afterClaim: async () => {
          during = await hook(
            path,
            {
              ...event({ event: "bounce", email_id: "never-stored", rcpt: address, time: "2026-11-13T10:00:00Z" }),
              "message-id": reply.messageId,
            },
            `Bearer ${token}`,
          )
        },
      },
    )
    expect(await second.send(reply.id)).toBe("unknown")
    expect((during as Response | null)?.status).toBe(200)
    expect(await possibleSends(reply.id)).toEqual([2])
    expect((await view(number)).messages.find((m) => m.id === reply.id)?.delivery).toMatchObject({
      unmatchedDelivery: { source: "webhook", status: "hard_bounce", recipient: address },
      recipients: [{ delivery: null }],
    })
  })

  it("D7: the recovery of a run that stopped after saving an unknown answer is not a new attempt", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const reply = await written(number, ["drop.dana@example.com"])
    // The unknown answer is saved, then the run stops before it settles the row (still `sending`).
    await expect(sender({ "failover.host": "" }, { afterRecord: async () => crash() }).send(reply.id)).rejects.toThrow()
    const [row] = await h.database.db.select({ state: outbox.state }).from(outbox).where(eq(outbox.messageId, reply.id))
    expect(row?.state).toBe("sending")
    // The next run finds it halfway and recovers it without sending.
    expect(await sender({ "failover.host": "" }).send(reply.id)).toBe("unknown")
    expect(await possibleSends(reply.id)).toEqual([1])
  })

  it("D8: the backfill never lets an old unknown recipient, or one sent again, match by Message-ID", async () => {
    await firstAdmin()
    const number = await customerTicket()
    const unknown = await sentReply(number, ["drop.dana@example.com"], { "failover.host": "" })
    const once = await sentReply(number, ["dana@example.com"])
    const resent = await sentReply(number, ["drop.ron@example.com"], { "failover.host": "" })
    expect((await admin.call("POST", `/api/v1/messages/${resent.id}/resend`)).status).toBe(200)
    expect(await sender(viaFailover()).send(resent.id)).toBe("accepted")
    // As rows sent before 0010.
    await h.database.db.update(outboxRecipient).set({ possibleSends: 0, acceptedAt: null })
    const file = readFileSync(join(MIGRATIONS_DIR, "0012_delivery_backfill.sql"), "utf8")
    for (const statement of file.split("--> statement-breakpoint"))
      if (statement.includes('"outbox_recipient"')) await h.database.db.execute(sql.raw(statement))
    expect(await possibleSends(unknown.id)).toEqual([2])
    expect(await possibleSends(once.id)).toEqual([1])
    expect(await possibleSends(resent.id)).toEqual([2])
  })
})
