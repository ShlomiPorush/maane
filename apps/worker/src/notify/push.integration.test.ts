// Browser notifications (plan 4.5) against a stand-in push service: what a push holds, who gets it, the user's own
// check before each send, revoked subscriptions, redirects, the allow list, and the job intake queues. Nothing
// reaches a real push service.

import { randomUUID } from "node:crypto"
import { organizationMember, pushSubscription } from "@maane/server/db/schema"
import { PUSH_NOTIFY, type PushJob } from "@maane/server/jobs/queue"
import { createTestApp } from "@maane/server/testing/app"
import { nextIp, TestBrowser, testPassword } from "@maane/server/testing/browser"
import { type Locale, MESSAGES, userEmail } from "@maane/shared"
import { and, eq } from "drizzle-orm"
import { decrypt } from "http_ece"
import { PgBoss } from "pg-boss"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import webpush from "web-push"
import { IntakeProcessor } from "../intake/process.ts"
import { type StandInClamd, startStandInClamd } from "../testing/clamd.ts"
import { type IntakeHarness, startIntake } from "../testing/intake.ts"
import { fromCodePoints, mime } from "../testing/mime.ts"
import { browserKeys, type PushRequest, type StandInPush, startStandInPush } from "../testing/push.ts"
import { PushNotifier, pushNotifyJob } from "./push.ts"

const SUPPORT = "support@example.com"
const OTHER = "billing@example.com"
const SUBJECT = "The invoice of March"
const BODY = fromCodePoints(0x5e9, 0x5dc, 0x5d5, 0x5dd)

let clamd: StandInClamd
let push: StandInPush
let h: IntakeHarness
let app: ReturnType<typeof createTestApp>
let support: string
let other: string
const password = testPassword()

beforeAll(async () => {
  clamd = await startStandInClamd()
  push = await startStandInPush()
})
afterAll(async () => {
  await clamd.close()
  await push.close()
})
beforeEach(async () => {
  h = await startIntake(clamd)
  support = await h.organization("Example Support", [{ value: SUPPORT, isDefault: true }])
  other = await h.organization("Example Other", [{ value: OTHER }])
  await h.mode("live")
  app = createTestApp(h.database)
  await app.ready
  push.received.length = 0
})
afterEach(async () => {
  await app.close()
  await h.close()
})

const browser = () => new TestBrowser(app.fetch, nextIp())

async function firstAdmin() {
  const b = browser()
  expect((await b.setup("first.admin", password)).status).toBe(200)
  await b.enroll(password)
  const me = await b.call("GET", "/api/v1/me")
  return { b, id: (me.json as { id: string }).id }
}

async function newAgent(admin: TestBrowser, name: string, organizationId: string | null) {
  const created = await admin.call("POST", "/api/auth/admin/create-user", {
    email: userEmail(name),
    password,
    name,
    role: "agent",
    data: { username: name },
  })
  expect(created.status).toBe(200)
  const id = (created.json as { user: { id: string } }).user.id
  if (organizationId) await h.database.db.insert(organizationMember).values({ organizationId, userId: id })
  return id
}

/** A device of a user: a subscription row on the stand-in, with the browser's keys kept to read what it receives. */
async function device(userId: string, locale: Locale = "he", endpoint = push.endpoint()) {
  const browserSide = browserKeys()
  await h.database.db.insert(pushSubscription).values({ userId, endpoint, ...browserSide.keys, locale })
  return { endpoint, ...browserSide }
}

type Device = Awaited<ReturnType<typeof device>>

const hits = (d: Device) => push.received.filter((request) => `${push.origin}${request.path}` === d.endpoint)

/** What the device's browser reads from a push: web-push's aes128gcm encryption, decrypted with its own keys. */
const opened = (request: PushRequest, d: Device) =>
  JSON.parse(decrypt(request.body, { version: "aes128gcm", privateKey: d.curve, authSecret: d.auth }).toString("utf8"))

const subscriptions = async (userId: string) =>
  h.database.db.select().from(pushSubscription).where(eq(pushSubscription.userId, userId))

function notifier(options: { publicUrl?: string; standIn?: boolean } = {}) {
  return new PushNotifier({
    db: h.database.db,
    vapid: webpush.generateVAPIDKeys(),
    publicUrl: new URL(options.publicUrl ?? "https://maane.example.com"),
    ...(options.standIn === false
      ? {}
      : { endpointAllowed: (endpoint: string) => endpoint.startsWith(`${push.origin}/`), agent: push.agent }),
  })
}

/** A customer's new ticket through intake, to the given support address. */
async function customerTicket(to = SUPPORT, from = "Dana Customer <dana@example.com>") {
  const messageId = `${randomUUID()}@mail.example.com`
  const graphId = h.graph.add(mime({ messageId, subject: SUBJECT, from, to, text: { content: BODY } }))
  await h.round()
  const found = await h.ticketOf(graphId)
  if (!found) throw new Error("no ticket")
  const row = await h.messageOf(graphId)
  const job: PushJob = { kind: "new_ticket", ticketId: found.id, messageId: row.id }
  return { number: found.number, messageId, job }
}

describe("the push-notify job", () => {
  it("sends only the number and the name, to every user allowed on the organization, in each device's language", async () => {
    const admin = await firstAdmin()
    const member = await newAgent(admin.b, "agent.member", support)
    const outsider = await newAgent(admin.b, "agent.outsider", other)
    const adminDevice = await device(admin.id, "he")
    const memberDevice = await device(member, "en")
    const outsiderDevice = await device(outsider, "en")
    const { number, job } = await customerTicket()

    expect(await notifier().notify(job)).toEqual({ sent: 2, removed: 0, failed: 0 })
    const [toAdmin] = hits(adminDevice)
    const [toMember] = hits(memberDevice)
    if (!toAdmin || !toMember) throw new Error("a device got nothing")
    expect(hits(outsiderDevice)).toHaveLength(0)
    expect(opened(toAdmin, adminDevice)).toEqual({
      title: MESSAGES.he.notifications.push.newTicket.replace("{number}", String(number)),
      body: "Dana Customer",
      number,
    })
    expect(opened(toMember, memberDevice)).toEqual({
      title: MESSAGES.en.notifications.push.newTicket.replace("{number}", String(number)),
      body: "Dana Customer",
      number,
    })
    // Signed with the VAPID key, encrypted for the device, and kept a day at most.
    expect(String(toAdmin.headers.authorization)).toMatch(/^vapid t=.+, k=.+$/)
    expect(toAdmin.headers["content-encoding"]).toBe("aes128gcm")
    expect(toAdmin.headers.ttl).toBe(String(24 * 60 * 60))
    expect(toAdmin.body.toString("latin1")).not.toContain("Dana")
  })

  it("names a customer reply, and shows no name when the sender gave none", async () => {
    const admin = await firstAdmin()
    const d = await device(admin.id, "en")
    const { number, job } = await customerTicket(SUPPORT, "dana@example.com")
    await notifier().notify({ ...job, kind: "customer_reply" })
    const [request] = hits(d)
    if (!request) throw new Error("nothing sent")
    expect(opened(request, d)).toEqual({
      title: MESSAGES.en.notifications.push.customerReply.replace("{number}", String(number)),
      body: "",
      number,
    })
  })

  it("sends nothing to a disabled user and deletes every subscription of theirs", async () => {
    const admin = await firstAdmin()
    const agent = await newAgent(admin.b, "agent.disabled", support)
    const first = await device(agent)
    const second = await device(agent, "en")
    const adminDevice = await device(admin.id)
    const { job } = await customerTicket()
    expect((await admin.b.call("POST", "/api/auth/admin/ban-user", { userId: agent })).status).toBe(200)

    expect(await notifier().notify(job)).toEqual({ sent: 1, removed: 2, failed: 0 })
    expect(hits(first)).toHaveLength(0)
    expect(hits(second)).toHaveLength(0)
    expect(await subscriptions(agent)).toHaveLength(0)
    expect(hits(adminDevice)).toHaveLength(1)
  })

  it("stops an organization's notifications for a user removed from it, without touching an authorized user", async () => {
    const admin = await firstAdmin()
    const removed = await newAgent(admin.b, "agent.removed", support)
    const staying = await newAgent(admin.b, "agent.staying", support)
    const removedDevice = await device(removed)
    const stayingDevice = await device(staying)
    const { job } = await customerTicket()
    await h.database.db
      .delete(organizationMember)
      .where(and(eq(organizationMember.userId, removed), eq(organizationMember.organizationId, support)))

    expect(await notifier().notify(job)).toEqual({ sent: 1, removed: 0, failed: 0 })
    expect(hits(removedDevice)).toHaveLength(0)
    expect(hits(stayingDevice)).toHaveLength(1)
    // Still subscribed: the user may be added again, or see other organizations.
    expect(await subscriptions(removed)).toHaveLength(1)
  })

  it("deletes a subscription the push service answers 404 or 410 for, and keeps one it failed for otherwise", async () => {
    const admin = await firstAdmin()
    const gone = await device(admin.id)
    const notFound = await device(admin.id)
    const failing = await device(admin.id)
    push.answer(gone.endpoint, 410)
    push.answer(notFound.endpoint, 404)
    push.answer(failing.endpoint, 500)
    const { job } = await customerTicket()

    expect(await notifier().notify(job)).toEqual({ sent: 0, removed: 2, failed: 1 })
    expect((await subscriptions(admin.id)).map((row) => row.endpoint)).toEqual([failing.endpoint])
  })

  it("does not follow a redirect", async () => {
    const admin = await firstAdmin()
    const d = await device(admin.id)
    const target = push.endpoint()
    push.answer(d.endpoint, 307, { location: target })
    const { job } = await customerTicket()

    expect(await notifier().notify(job)).toEqual({ sent: 0, removed: 0, failed: 1 })
    expect(hits(d)).toHaveLength(1)
    expect(push.received.filter((request) => `${push.origin}${request.path}` === target)).toHaveLength(0)
    expect(await subscriptions(admin.id)).toHaveLength(1)
  })

  it("sends nothing to an endpoint off the push services' allow list, also when it is stored", async () => {
    const admin = await firstAdmin()
    // The stand-in itself (a loopback address), an internal name, and an address: the production allow list takes
    // none of them.
    const standIn = await device(admin.id)
    await device(admin.id, "he", "https://localhost/push/one")
    await device(admin.id, "he", "https://192.0.2.10/push/two")
    const { job } = await customerTicket()

    expect(await notifier({ standIn: false }).notify(job)).toEqual({ sent: 0, removed: 0, failed: 3 })
    expect(hits(standIn)).toHaveLength(0)
    expect(push.received).toHaveLength(0)
  })

  it("sends nothing while the public URL is http (the push services need an https subject)", async () => {
    const admin = await firstAdmin()
    await device(admin.id)
    const { job } = await customerTicket()
    expect(await notifier({ publicUrl: "http://127.0.0.1:8095" }).notify(job)).toEqual({
      sent: 0,
      removed: 0,
      failed: 0,
    })
    expect(push.received).toHaveLength(0)
  })

  it("takes only a job of its own shape", async () => {
    const n = notifier()
    expect(await pushNotifyJob(n, null)).toBeNull()
    expect(await pushNotifyJob(n, { kind: "other", ticketId: randomUUID(), messageId: randomUUID() })).toBeNull()
    expect(await pushNotifyJob(n, { kind: "new_ticket", ticketId: 1, messageId: randomUUID() })).toBeNull()
  })
})

describe("intake's notifications", () => {
  let boss: PgBoss
  beforeEach(async () => {
    boss = new PgBoss({ connectionString: h.database.url, schema: "pgboss", supervise: false, schedule: false })
    await boss.start()
    await boss.createQueue(PUSH_NOTIFY, { retryLimit: 0 })
  })
  afterEach(async () => {
    await boss.stop({ graceful: false })
  })

  /** Stage one, then stage two with a processor that queues notifications in its own transactions. */
  async function round() {
    await h.sync.run()
    const processor = new IntakeProcessor({
      db: h.database.db,
      notify: async (jobs, job) => {
        const id = await boss.send(PUSH_NOTIFY, job, { db: jobs })
        if (!id) throw new Error("not queued")
      },
    })
    await processor.run()
  }

  const queued = async () => {
    const jobs = await boss.fetch<PushJob>(PUSH_NOTIFY, { batchSize: 50 })
    return jobs.map((job) => job.data)
  }

  it("queues one for a new ticket and one for a customer's message that joins it, in live mode only", async () => {
    const original = `${randomUUID()}@mail.example.com`
    const first = h.graph.add(mime({ messageId: original, subject: SUBJECT, to: SUPPORT, text: { content: BODY } }))
    await round()
    const ticket = await h.ticketOf(first)
    const firstRow = await h.messageOf(first)
    expect(await queued()).toEqual([{ kind: "new_ticket", ticketId: ticket?.id, messageId: firstRow.id }])

    const reply = h.graph.add(
      mime({
        subject: `Re: ${SUBJECT}`,
        to: SUPPORT,
        inReplyTo: original,
        references: [original],
        text: { content: BODY },
      }),
    )
    await round()
    const replyRow = await h.messageOf(reply)
    expect(replyRow.ticketId).toBe(ticket?.id)
    expect(await queued()).toEqual([{ kind: "customer_reply", ticketId: ticket?.id, messageId: replyRow.id }])

    // Automated mail opens and joins nothing, and notifies nobody.
    h.graph.add(
      mime({
        subject: "Out of office",
        to: SUPPORT,
        headers: [["Auto-Submitted", "auto-replied"]],
        text: { content: BODY },
      }),
    )
    await round()
    expect(await queued()).toEqual([])

    // Listening mode keeps shadow conversations: no ticket, no notification.
    await h.mode("listening")
    h.graph.add(mime({ subject: "While listening", to: SUPPORT, text: { content: BODY } }))
    await round()
    expect(await queued()).toEqual([])
  })
})
