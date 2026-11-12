import { randomBytes } from "node:crypto"
import { userEmail } from "@maane/shared"
import { eq } from "drizzle-orm"
import { PgBoss } from "pg-boss"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { auditLog, intakeSource, setting } from "../db/schema.ts"
import { GRAPH_TEST, type JobQueue, openJobQueue } from "../jobs/queue.ts"
import { createTestApp } from "../testing/app.ts"
import { nextIp, TestBrowser, testPassword } from "../testing/browser.ts"
import { createTestDatabase } from "../testing/db.ts"

// Graph on the Settings page (plan 2.3): the four settings, the secret stored encrypted and never returned, the intake
// source that a tenant or mailbox change makes current, and the connection test the server only queues. A pg-boss
// client plays the worker through pg-boss's documented fetch and complete.

let database: Awaited<ReturnType<typeof createTestDatabase>>
let queue: JobQueue
let app: ReturnType<typeof createTestApp>
let worker: PgBoss
const password = testPassword()

beforeEach(async () => {
  database = await createTestDatabase()
  queue = await openJobQueue(database.url)
  app = createTestApp(database, {}, queue)
  await app.ready
  worker = new PgBoss({ connectionString: database.url, schema: "pgboss", supervise: false, schedule: false })
  await worker.start()
})
afterEach(async () => {
  await worker.stop({ graceful: false })
  await queue.stop()
  await app.close()
  await database.drop()
})

async function firstAdmin() {
  const b = new TestBrowser(app.fetch, nextIp())
  expect((await b.setup("first.admin", password)).status).toBe(200)
  await b.enroll(password)
  return b
}

/** A client secret in the form Entra issues, new for each run. */
const clientSecret = () => `${randomBytes(3).toString("hex")}8Q~${randomBytes(18).toString("hex")}`

describe("Graph in Settings", () => {
  it("stores the client secret encrypted, never returns it, and makes the tenant and mailbox the current source", async () => {
    const admin = await firstAdmin()
    const tenant = crypto.randomUUID()
    const secret = clientSecret()
    const saved = await admin.call("PUT", "/api/v1/settings", {
      "graph.tenantId": tenant.toUpperCase(),
      "graph.clientId": crypto.randomUUID(),
      "graph.clientSecret": secret,
      "graph.mailbox": "intake@example.com",
    })
    expect(saved.status).toBe(200)
    expect(JSON.stringify(saved.json)).not.toContain(secret)
    expect(saved.json.settings).toContainEqual({
      key: "graph.clientSecret",
      value: null,
      secret: true,
      set: true,
      locked: false,
      variable: null,
    })
    const [row] = await database.db.select().from(setting).where(eq(setting.key, "graph.clientSecret"))
    expect(row?.value).toBeNull()
    expect(row?.ciphertext).toBeTruthy()
    expect(row?.ciphertext).not.toContain(secret)
    const audits = await database.db.select().from(auditLog).where(eq(auditLog.entityId, "graph.clientSecret"))
    expect(audits.map((audit) => audit.details)).toEqual([{ secret: true }])
    expect(JSON.stringify(await database.db.select().from(auditLog))).not.toContain(secret)

    const sources = async () =>
      (await database.db.select().from(intakeSource)).map((source) => [source.tenantId, source.mailbox, source.current])
    expect(await sources()).toEqual([[tenant, "intake@example.com", true]])
    // Another mailbox: a new current source; the old one stays, not current. Back again: the old one is current.
    expect((await admin.call("PUT", "/api/v1/settings", { "graph.mailbox": "Other@Example.com" })).status).toBe(200)
    expect((await sources()).sort()).toEqual([
      [tenant, "intake@example.com", false],
      [tenant, "other@example.com", true],
    ])
    expect((await admin.call("PUT", "/api/v1/settings", { "graph.mailbox": "intake@example.com" })).status).toBe(200)
    expect((await sources()).sort()).toEqual([
      [tenant, "intake@example.com", true],
      [tenant, "other@example.com", false],
    ])
    // Another setting leaves the source alone.
    expect((await admin.call("PUT", "/api/v1/settings", { "security.sessionDays": 20 })).status).toBe(200)
    expect((await sources()).filter((source) => source[2])).toHaveLength(1)
    for (const [key, value] of [
      ["graph.mailbox", "intake"],
      ["graph.tenantId", "not a tenant"],
      ["graph.clientId", "application"],
      ["graph.clientSecret", " padded "],
      ["graph.clientSecret", ""],
    ] as const)
      expect((await admin.call("PUT", "/api/v1/settings", { [key]: value })).json).toMatchObject({
        error: "setting_invalid",
        key,
      })
  })

  it("queues a connection test for the worker and reports its state and result", async () => {
    const admin = await firstAdmin()
    const queued = await admin.call("POST", "/api/v1/settings/graph/test")
    expect(queued.status).toBe(202)
    const id = queued.json.id as string
    expect((await admin.call("GET", `/api/v1/settings/graph/test/${id}`)).json).toEqual({
      state: "queued",
      result: null,
    })
    const [job] = await worker.fetch(GRAPH_TEST)
    expect(job?.id).toBe(id)
    const output = {
      ok: false,
      problem: "access_denied",
      code: "ErrorAccessDenied",
      status: 403,
      mailbox: "intake@example.com",
      checkedAt: "2026-11-12T10:00:00.000Z",
    }
    await worker.complete(GRAPH_TEST, id, output)
    expect((await admin.call("GET", `/api/v1/settings/graph/test/${id}`)).json).toEqual({
      state: "done",
      result: output,
    })
    // An output that is not a test result reads as failed; an unknown job is not found.
    const other = (await admin.call("POST", "/api/v1/settings/graph/test")).json.id as string
    await worker.fetch(GRAPH_TEST)
    await worker.complete(GRAPH_TEST, other, { unexpected: true })
    expect((await admin.call("GET", `/api/v1/settings/graph/test/${other}`)).json).toEqual({
      state: "failed",
      result: null,
    })
    expect((await admin.call("GET", "/api/v1/settings/graph/test/not-a-job")).status).toBe(404)
  })

  it("refuses an agent", async () => {
    const admin = await firstAdmin()
    const created = await admin.call("POST", "/api/auth/admin/create-user", {
      email: userEmail("an.agent"),
      password,
      name: "an.agent",
      role: "agent",
      data: { username: "an.agent" },
    })
    expect(created.status).toBe(200)
    const b = new TestBrowser(app.fetch, nextIp())
    expect((await b.passwordSignIn("an.agent", password)).status).toBe(200)
    await b.enroll(password)
    expect((await b.call("POST", "/api/v1/settings/graph/test")).status).toBe(403)
    expect((await b.call("GET", `/api/v1/settings/graph/test/${crypto.randomUUID()}`)).status).toBe(403)
  })
})
