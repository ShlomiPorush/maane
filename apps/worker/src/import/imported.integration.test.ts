import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SYSTEM } from "@maane/server/audit"
import { auditLog, authUser, category, organization, outbox, supportAddress, ticket } from "@maane/server/db/schema"
import {
  type JobQueue,
  openJobQueue,
  QUEUE_OPTIONS,
  ZENDESK_IMPORT,
  ZENDESK_IMPORT_HEARTBEAT_SECONDS,
} from "@maane/server/jobs/queue"
import { Organizations } from "@maane/server/organizations/service"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { createTestApp } from "@maane/server/testing/app"
import { nextIp, TestBrowser, testPassword } from "@maane/server/testing/browser"
import { createTestDatabase, testKey } from "@maane/server/testing/db"
import { png } from "@maane/server/testing/files"
import {
  type ImportReportPage,
  type ImportView,
  MEGABYTE,
  type TicketList,
  type TicketView,
  userEmail,
} from "@maane/shared"
import { ArchiveReader } from "@maane/zendesk"
import type { StandInZendesk } from "@maane/zendesk/testing/stand-in"
import { eq, sql } from "drizzle-orm"
import { simpleParser } from "mailparser"
import { PgBoss } from "pg-boss"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { clamdScanner } from "../files/scanner.ts"
import { FileService } from "../files/service.ts"
import { FileStore } from "../files/store.ts"
import { MARKERS, type StandInClamd, startStandInClamd } from "../testing/clamd.ts"
import { BRANDS, backupInto, HEBREW_BODY, standInAccount } from "../testing/zendesk-archive.ts"
import { ZendeskImport } from "./run.ts"

const SUPPORT = "store@example.com"
const password = testPassword()

let clamd: StandInClamd
let database: Awaited<ReturnType<typeof createTestDatabase>>
let queue: JobQueue
let app: ReturnType<typeof createTestApp>
let zendesk: StandInZendesk
let importer: ZendeskImport
let root: string
let org: string
let outlet: string
let vip: string

beforeAll(async () => {
  clamd = await startStandInClamd()
})
afterAll(async () => {
  await clamd.close()
})
beforeEach(async () => {
  database = await createTestDatabase()
  root = await mkdtemp(join(tmpdir(), "maane-imported-"))
  const store = new FileStore(join(root, "files"))
  await store.prepare()
  const settings = new Settings(database.db, createSettingsCipher([{ version: 1, value: testKey() }]), {})
  await settings.update(
    { "scanner.address": clamd.address, "scanner.unavailablePolicy": "block", "files.maxBytes": 5 * MEGABYTE },
    SYSTEM,
  )
  const files = new FileService({ db: database.db, settings, scanner: clamdScanner, store })
  zendesk = standInAccount()
  await zendesk.start()
  const archive = join(root, "archive")
  await backupInto(zendesk, archive)
  importer = new ZendeskImport({ db: database.db, files, archiveDir: archive })
  queue = await openJobQueue(database.url)
  app = createTestApp(database, {}, queue, join(root, "files"), {}, undefined, archive)
  await app.ready
  const [made] = await database.db.insert(organization).values({ name: "Example Store" }).returning()
  const [second] = await database.db.insert(organization).values({ name: "Example Outlet" }).returning()
  org = made?.id ?? ""
  outlet = second?.id ?? ""
  await database.db
    .insert(supportAddress)
    .values({ organizationId: org, kind: "exact", value: SUPPORT, isDefault: true })
  await database.db
    .insert(supportAddress)
    .values({ organizationId: outlet, kind: "exact", value: "outlet@example.com" })
  const [tag] = await database.db.insert(category).values({ name: "VIP" }).returning()
  vip = tag?.id ?? ""
})
afterEach(async () => {
  await queue.stop()
  await app.close()
  await zendesk.stop()
  await database.drop()
  await rm(root, { recursive: true, force: true })
})

const browser = () => new TestBrowser(app.fetch, nextIp())

async function firstAdmin() {
  const b = browser()
  expect((await b.setup("first.admin", password)).status).toBe(200)
  await b.enroll(password)
  const [row] = await database.db.select({ id: authUser.id }).from(authUser).where(eq(authUser.username, "first.admin"))
  return { b, id: row?.id ?? "" }
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
  for (const organizationId of organizations)
    await new Organizations(database.db).addMember(organizationId, created.json.user.id, {
      actor: SYSTEM,
      ipAddress: null,
    })
  const b = browser()
  expect((await b.passwordSignIn(name, password)).status).toBe(200)
  await b.enroll(password)
  return b
}

async function mapped(admin: { b: TestBrowser; id: string }) {
  const saved = await admin.b.call("PUT", "/api/v1/admin/import/mapping", {
    brands: { [String(BRANDS.mapped)]: org, [String(BRANDS.other)]: null },
    tags: { vip, billing: null },
    agentUserId: admin.id,
  })
  expect(saved.status, JSON.stringify(saved.json)).toBe(200)
}

async function imported(admin: { b: TestBrowser; id: string }) {
  await mapped(admin)
  const started = await admin.b.call("POST", "/api/v1/admin/import/start")
  expect(started.status).toBe(202)
  expect(await importer.run(started.json.run.id)).toEqual({ state: "done", reason: null })
  return started.json.run.id as string
}

const reply = (values: Record<string, unknown> = {}) => ({
  submissionId: randomUUID(),
  kind: "reply",
  from: SUPPORT,
  to: [{ address: "user2@example.com", name: "User 2" }],
  cc: [],
  html: "<p>We sent a new package.</p>",
  uploads: [],
  parts: [],
  ...values,
})

describe("imported tickets", () => {
  it("the import page maps, starts a run, shows its progress, and pages its report; admins only", async () => {
    const admin = await firstAdmin()
    const page = await admin.b.call("GET", "/api/v1/admin/import")
    expect(page.status).toBe(200)
    const view = page.json as ImportView
    expect(view.window).toEqual({ open: true, finishedAt: null })
    expect(view.archive).toMatchObject({ present: true, backupRunning: false, otherOrigin: false, tickets: 6 })
    expect(view.brands.map((brand) => [brand.id, brand.name, brand.tickets])).toEqual([
      [String(BRANDS.mapped), "Example Store", 5],
      [String(BRANDS.other), "Example Outlet", 1],
    ])
    expect(view.tags.map((tag) => [tag.tag, tag.tickets])).toEqual([
      ["billing", 2],
      ["vip", 1],
    ])
    expect(view.users.map((user) => user.id)).toEqual([admin.id])
    expect((await admin.b.call("POST", "/api/v1/admin/import/start")).json.error).toBe("import_no_agent")

    const agent = await newAgent(admin.b, "agent.one", [org])
    expect((await agent.call("GET", "/api/v1/admin/import")).status).toBe(403)
    expect((await agent.call("POST", "/api/v1/admin/import/start")).status).toBe(403)

    const run = await imported(admin)
    const progress = await admin.b.call("GET", "/api/v1/admin/import/run")
    expect(progress.json.run).toMatchObject({ id: run, state: "done", done: 7, total: 7, reportRows: 6 })
    const report = await admin.b.call("GET", `/api/v1/admin/import/runs/${run}/report`)
    expect(report.json.rows.map((row: { reason: string }) => row.reason)).toEqual([
      "blocked_content",
      "file_failed",
      "file_failed",
      "deleted_in_zendesk",
      "deleted_in_zendesk",
      "unmapped_brand",
    ])
    expect(report.json.next).toBeNull()
    const after = await admin.b.call("GET", `/api/v1/admin/import/runs/${run}/report?after=${report.json.rows[3].id}`)
    expect(after.json.rows).toHaveLength(2)

    const [open] = await database.db.select().from(ticket).limit(1)
    expect(open).toBeDefined()
    const again = await admin.b.call("POST", "/api/v1/admin/import/start")
    const second = again.json.run.id as string
    expect((await admin.b.call("POST", "/api/v1/admin/import/start")).json.run.id).toBe(second)
    const refused = await admin.b.call("PUT", "/api/v1/admin/import/mapping", {
      brands: {},
      tags: {},
      agentUserId: admin.id,
    })
    expect(refused.json.error).toBe("import_running")
    expect((await admin.b.call("POST", "/api/v1/admin/import/finish")).json.error).toBe("import_running")
    expect((await agent.call("POST", "/api/v1/admin/import/finish")).status).toBe(403)
    expect(await importer.run(second)).toEqual({ state: "done", reason: null })
  })

  it("keeps every imported ticket read-only for agents until Finish import, then lets it be answered with its history", async () => {
    const admin = await firstAdmin()
    await imported(admin)
    const b = admin.b
    const refusedWith = async (method: string, path: string, body?: unknown) => {
      const answer = await b.call(method, path, body)
      return [answer.status, answer.json.error]
    }
    const read = [409, "ticket_imported"]
    expect(await refusedWith("PUT", "/api/v1/tickets/1/status", { status: "solved" })).toEqual(read)
    expect(await refusedWith("PUT", "/api/v1/tickets/1/categories", { categories: [] })).toEqual(read)
    expect(await refusedWith("PUT", "/api/v1/tickets/1/organization", { organizationId: outlet })).toEqual(read)
    const until = new Date(Date.now() + 3_600_000).toISOString()
    expect(await refusedWith("PUT", "/api/v1/tickets/1/snooze", { until })).toEqual(read)
    expect(await refusedWith("DELETE", "/api/v1/tickets/1/snooze")).toEqual(read)
    expect(
      await refusedWith("POST", "/api/v1/tickets/1/messages", reply({ kind: "note", from: null, to: [] })),
    ).toEqual(read)
    expect(await refusedWith("POST", "/api/v1/tickets/1/messages", reply())).toEqual(read)
    expect(await refusedWith("POST", "/api/v1/tickets/1/messages", reply({ sendAt: until }))).toEqual(read)
    expect(await refusedWith("DELETE", `/api/v1/admin/categories/${vip}`)).toEqual([409, "category_imported"])
    const [spare] = await database.db.insert(category).values({ name: "Spare" }).returning()
    expect((await b.call("DELETE", `/api/v1/admin/categories/${spare?.id}`)).status).toBe(200)

    const view = (await b.call("GET", "/api/v1/tickets/1")).json as TicketView
    expect(view.ticket.imported).toMatchObject({
      zendeskId: 1,
      readOnly: true,
      brand: "Example Store",
      tags: ["vip", "billing"],
      fields: [
        { name: "Order number", value: "A-17" },
        { name: "Plan", value: "Gold plan" },
      ],
    })
    expect(view.ticket.categories.map((c) => c.name)).toEqual(["VIP"])
    expect(view.messages.map((m) => [m.direction, m.imported?.authorName, m.imported?.sideConversation])).toEqual([
      ["in", "User 2", false],
      ["note", "Dana Agent", false],
      ["out", "Dana Agent", false],
      ["note", null, true],
    ])
    expect(view.links.map((link) => [link.number, link.reason])).toEqual([
      [3, "merged"],
      [7, "follow_up"],
    ])

    const finished = await b.call("POST", "/api/v1/admin/import/finish")
    expect(finished.status).toBe(200)
    expect((finished.json as ImportView).window).toMatchObject({ open: false })
    expect((finished.json as ImportView).window.finishedAt).not.toBeNull()
    expect(((await b.call("GET", "/api/v1/tickets/1")).json as TicketView).ticket.imported?.readOnly).toBe(false)
    expect((await b.call("POST", "/api/v1/admin/import/start")).json.error).toBe("import_closed")
    const sent = await b.call("POST", "/api/v1/tickets/1/messages", reply())
    expect(sent.status, JSON.stringify(sent.json)).toBe(201)
    const [row] = await database.db.select().from(outbox).where(eq(outbox.messageId, sent.json.id))
    const mail = await simpleParser(row?.mime ?? Buffer.alloc(0))
    expect(mail.html).toContain(HEBREW_BODY)
    expect(mail.html).toContain("Answer")
    expect(mail.html).not.toContain("Internal note")
    expect(mail.text).toContain("Answer")
    expect((await b.call("PUT", "/api/v1/tickets/1/status", { status: "solved" })).status).toBe(200)
    expect((await b.call("DELETE", `/api/v1/admin/categories/${vip}`)).status).toBe(200)
  })

  it("shows imported files as intake's (status, preview, download, the inline image from its own part), read-only too", async () => {
    const shot = png(8, 8)
    zendesk.change(1, (t) => {
      const question = t.comments[0]
      if (!question) return
      question.files.push({ id: 104, name: "shot.png", content: shot, serve: "redirect", inline: true })
      question.files.push({
        id: 103,
        name: "virus.txt",
        content: Buffer.from(`virus ${MARKERS.infected}`),
        serve: "redirect",
      })
      question.extra = {
        ...question.extra,
        html_body: `<p>${HEBREW_BODY}</p><p><img src="${zendesk.apiOrigin}/attachments/token/t104/?name=shot.png" alt="shot"><img src="https://images.example.com/logo.png" alt="logo"></p>`,
      }
    })
    await backupInto(zendesk, join(root, "archive"))
    const admin = await firstAdmin()
    const runId = await imported(admin)
    const b = admin.b

    const view = (await b.call("GET", "/api/v1/tickets/1")).json as TicketView
    const question = view.messages[0]
    expect(question?.attachments.map((a) => [a.fileName, a.kind, a.status, a.preview, a.download])).toEqual([
      ["invoice.pdf", "attachment", "clean", null, true],
      ["a.png", "inline", "clean", null, true],
      ["shot.png", "inline", "clean", "image", true],
      ["virus.txt", "attachment", "infected", null, false],
    ])
    expect(question?.attachments[3]?.signature).toBe("Eicar-Test-Signature")
    const [invoice, , image, virus] = question?.attachments ?? []
    const download = await b.get(`/api/v1/files/${invoice?.id}`)
    expect(download.status).toBe(200)
    expect(Buffer.from(await download.arrayBuffer())).toEqual(zendesk.allFiles().find((f) => f.id === 101)?.content)
    const preview = await b.get(`/api/v1/files/${image?.id}/preview`)
    expect([preview.status, preview.headers.get("content-type")]).toEqual([200, "image/png"])
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(shot)
    expect((await b.get(`/api/v1/files/${virus?.id}`)).status).toBe(404)
    expect(question?.remoteImages).toBe(1)
    const body = await (await b.get(`/api/v1/messages/${question?.id}/body`)).text()
    expect(body).toContain(`data:image/png;base64,${shot.toString("base64")}`)
    expect(body).not.toContain("attachments/token")
    expect(body).not.toContain("images.example.com")
    const shown = await (await b.get(`/api/v1/messages/${question?.id}/body?images=1`)).text()
    expect(shown).toContain("https://images.example.com/logo.png")
    const report = (await b.call("GET", `/api/v1/admin/import/runs/${runId}/report`)).json as ImportReportPage
    expect(report.rows.map((row) => [row.zendeskId, row.reason, row.detail])).toContainEqual([
      1,
      "file_infected",
      "virus.txt",
    ])
    const answer = await b.call("POST", "/api/v1/tickets/1/messages", reply({ parts: [image?.id] }))
    expect([answer.status, answer.json.error]).toEqual([409, "ticket_imported"])
  })

  it("offers Continue for an open run whose job is gone, and the report says which ticket stopped it", async () => {
    const admin = await firstAdmin()
    await mapped(admin)
    await database.db.execute(
      sql`alter table ticket add constraint test_refuses_three check (zendesk_id is distinct from 3)`,
    )
    const started = await admin.b.call("POST", "/api/v1/admin/import/start")
    const id = started.json.run.id as string
    expect(started.json.run).toMatchObject({ state: "running", jobActive: true })
    await expect(importer.run(id)).rejects.toThrow()
    expect((await admin.b.call("GET", "/api/v1/admin/import/run")).json.run).toMatchObject({
      state: "running",
      reason: "failed",
      jobActive: true,
    })
    const boss = new PgBoss({ connectionString: database.url, supervise: false, schedule: false })
    await boss.start()
    const jobs = await boss.findJobs(ZENDESK_IMPORT, { data: { runId: id } })
    expect(jobs).toHaveLength(1)
    const taken = await boss.fetch(ZENDESK_IMPORT)
    expect(taken.map((job) => job.id)).toEqual([jobs[0]?.id])
    expect((await admin.b.call("GET", "/api/v1/admin/import/run")).json.run).toMatchObject({
      jobActive: true,
      retrying: false,
    })
    await boss.fail(ZENDESK_IMPORT, jobs[0]?.id ?? "")
    expect((await admin.b.call("GET", "/api/v1/admin/import/run")).json.run).toMatchObject({
      state: "running",
      reason: "failed",
      jobActive: true,
      retrying: true,
    })
    await boss.cancel(
      ZENDESK_IMPORT,
      jobs.map((job) => job.id),
    )
    await boss.stop({ graceful: false })
    expect((await admin.b.call("GET", "/api/v1/admin/import/run")).json.run).toMatchObject({
      id,
      state: "running",
      reason: "failed",
      jobActive: false,
      retrying: false,
    })
    const report = await admin.b.call("GET", `/api/v1/admin/import/runs/${id}/report`)
    expect(report.json.rows.filter((row: { reason: string }) => row.reason === "ticket_failed")).toMatchObject([
      { zendeskId: 3, detail: "rule:test_refuses_three" },
    ])
    expect((await admin.b.call("POST", "/api/v1/admin/import/finish")).json.error).toBe("import_running")
    await database.db.execute(sql`alter table ticket drop constraint test_refuses_three`)
    const resumed = await admin.b.call("POST", "/api/v1/admin/import/start")
    expect(resumed.json.run).toMatchObject({ id, state: "running", jobActive: true })
    expect(await importer.run(id)).toEqual({ state: "done", reason: null })
    expect((await admin.b.call("GET", "/api/v1/admin/import/run")).json.run).toMatchObject({
      id,
      state: "done",
      reason: null,
      jobActive: false,
      done: 7,
    })
  })

  it("cancels an open run whose job waits, and one stopped on an error; the next start is a full pass", async () => {
    const admin = await firstAdmin()
    await mapped(admin)
    const started = await admin.b.call("POST", "/api/v1/admin/import/start")
    const id = started.json.run.id as string
    expect((await admin.b.call("POST", "/api/v1/admin/import/cancel")).json.error).toBe("request_invalid")
    expect((await admin.b.call("POST", "/api/v1/admin/import/cancel", { runId: "x" })).json.error).toBe(
      "request_invalid",
    )
    const cancelled = await admin.b.call("POST", "/api/v1/admin/import/cancel", { runId: id })
    expect(cancelled.status).toBe(200)
    expect(cancelled.json.cancelled).toBe(true)
    expect(cancelled.json.run).toMatchObject({ id, state: "stopped", reason: "cancelled", jobActive: false })
    expect(await importer.run(id)).toEqual({ skipped: true })
    expect(await database.db.select().from(ticket)).toEqual([])
    const audit = await database.db.select().from(auditLog).where(eq(auditLog.action, "import.cancel"))
    expect(audit).toMatchObject([{ entityId: id, actorUserId: admin.id }])
    await mapped(admin)

    await database.db.execute(
      sql`alter table ticket add constraint test_refuses_three check (zendesk_id is distinct from 3)`,
    )
    const second = (await admin.b.call("POST", "/api/v1/admin/import/start")).json.run.id as string
    await expect(importer.run(second)).rejects.toThrow()
    expect((await admin.b.call("POST", "/api/v1/admin/import/cancel", { runId: id })).json).toMatchObject({
      cancelled: false,
      run: { id: second, state: "running" },
    })
    expect((await admin.b.call("POST", "/api/v1/admin/import/cancel", { runId: second })).json).toMatchObject({
      cancelled: true,
      run: { id: second, state: "stopped", reason: "cancelled", done: 2 },
    })
    await database.db.execute(sql`alter table ticket drop constraint test_refuses_three`)
    expect((await admin.b.call("POST", "/api/v1/admin/import/cancel", { runId: second })).json).toMatchObject({
      cancelled: false,
      run: { id: second },
    })
    const third = (await admin.b.call("POST", "/api/v1/admin/import/start")).json.run.id as string
    expect(third).not.toBe(second)
    expect((await admin.b.call("POST", "/api/v1/admin/import/cancel", { runId: second })).json).toMatchObject({
      cancelled: false,
      run: { id: third, state: "running" },
    })
    expect(await importer.run(third)).toEqual({ state: "done", reason: null })
    expect((await admin.b.call("GET", "/api/v1/admin/import/run")).json.run).toMatchObject({ id: third, done: 7 })
    expect(await database.db.select().from(auditLog).where(eq(auditLog.action, "import.cancel"))).toHaveLength(2)
    const agent = await newAgent(admin.b, "agent.one", [org])
    expect((await agent.call("POST", "/api/v1/admin/import/cancel")).status).toBe(403)
  })

  it("queues a run's job with a heartbeat, so a worker that died is noticed long before the job expires", async () => {
    const admin = await firstAdmin()
    await mapped(admin)
    const id = (await admin.b.call("POST", "/api/v1/admin/import/start")).json.run.id as string
    expect((await admin.b.call("POST", "/api/v1/admin/import/start")).json.run.id).toBe(id)
    const boss = new PgBoss({
      connectionString: database.url,
      supervise: false,
      schedule: false,
      monitorIntervalSeconds: 1,
    })
    await boss.start()
    try {
      const queued = await boss.findJobs(ZENDESK_IMPORT, { data: { runId: id } })
      expect(queued.map((job) => [job.heartbeatSeconds, job.expireInSeconds])).toEqual([
        [ZENDESK_IMPORT_HEARTBEAT_SECONDS, QUEUE_OPTIONS[ZENDESK_IMPORT]?.expireInSeconds],
        [ZENDESK_IMPORT_HEARTBEAT_SECONDS, QUEUE_OPTIONS[ZENDESK_IMPORT]?.expireInSeconds],
      ])
      await boss.cancel(
        ZENDESK_IMPORT,
        queued.map((job) => job.id),
      )
      const lost = await boss.send(ZENDESK_IMPORT, { runId: "lost" }, { heartbeatSeconds: 10 })
      expect((await boss.fetch(ZENDESK_IMPORT)).map((job) => job.id)).toEqual([lost])
      const working = await boss.send(ZENDESK_IMPORT, { runId: "working" }, { heartbeatSeconds: 10 })
      let release = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let started = false
      await boss.work(ZENDESK_IMPORT, { pollingIntervalSeconds: 0.5 }, async () => {
        started = true
        await held
      })
      await vi.waitFor(() => expect(started).toBe(true), { timeout: 5_000 })
      await new Promise((resolve) => setTimeout(resolve, 13_000))
      await boss.supervise(ZENDESK_IMPORT)
      expect((await boss.getJobById(ZENDESK_IMPORT, lost ?? ""))?.state).toBe("retry")
      expect((await boss.getJobById(ZENDESK_IMPORT, working ?? ""))?.state).toBe("active")
      release()
      await vi.waitFor(async () =>
        expect((await boss.getJobById(ZENDESK_IMPORT, working ?? ""))?.state).toBe("completed"),
      )
    } finally {
      await boss.stop({ graceful: false })
    }
  }, 40_000)

  it("reads the archive's tickets for the page once per archive state", async () => {
    const admin = await firstAdmin()
    const read = vi.spyOn(ArchiveReader.prototype, "tickets")
    try {
      expect((await admin.b.call("GET", "/api/v1/admin/import")).json.archive).toMatchObject({ runs: 1, tickets: 6 })
      await admin.b.call("GET", "/api/v1/admin/import")
      expect(read).toHaveBeenCalledTimes(1)
      zendesk.setStatus(6, "deleted")
      await backupInto(zendesk, join(root, "archive"))
      expect((await admin.b.call("GET", "/api/v1/admin/import")).json.archive).toMatchObject({ runs: 2, tickets: 5 })
      expect(read).toHaveBeenCalledTimes(2)
    } finally {
      read.mockRestore()
    }
  })

  it("makes the requester the composer's recipient even when a CC's address sorts first", async () => {
    zendesk.change(1, (t) => {
      t.record = { ...t.record, requester_id: 3, email_cc_ids: [2] }
    })
    await backupInto(zendesk, join(root, "archive"))
    const admin = await firstAdmin()
    await imported(admin)
    const view = (await admin.b.call("GET", "/api/v1/tickets/1")).json as TicketView
    expect(view.compose.to.map((entry) => entry.address)).toEqual(["user3@example.com"])
    expect(view.compose.cc.map((entry) => entry.address)).toEqual(["user2@example.com"])
  })

  it("shows imported tickets only within the organization scope, in the list and in search", async () => {
    const admin = await firstAdmin()
    await imported(admin)
    const member = await newAgent(admin.b, "agent.store", [org])
    const stranger = await newAgent(admin.b, "agent.outlet", [outlet])
    const numbers = async (b: TestBrowser, query: string) =>
      ((await b.call("GET", `/api/v1/tickets?${query}`)).json as TicketList).tickets.map((t) => t.number).sort()
    expect(await numbers(member, "status=all")).toEqual([1, 2, 3, 7])
    expect(await numbers(stranger, "status=all")).toEqual([])
    expect(await numbers(member, `q=${encodeURIComponent("user3@example.com")}`)).toEqual([1, 2])
    expect(await numbers(member, `q=${encodeURIComponent(HEBREW_BODY.slice(0, 6))}`)).toEqual([1])
    expect(await numbers(stranger, `q=${encodeURIComponent("user3@example.com")}`)).toEqual([])
    expect((await stranger.call("GET", "/api/v1/tickets/1")).status).toBe(404)
  })
})
