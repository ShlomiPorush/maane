import { userEmail } from "@maane/shared"
import { PgBoss } from "pg-boss"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { scannerCheck } from "../db/schema.ts"
import { type JobQueue, openJobQueue, SCANNER_SELF_TEST } from "../jobs/queue.ts"
import { createTestApp } from "../testing/app.ts"
import { nextIp, TestBrowser, testPassword } from "../testing/browser.ts"
import { createTestDatabase } from "../testing/db.ts"

// The scanner on the Settings page: the latest self-test, and a connection test the server only queues. The worker
// runs it (apps/worker); here a pg-boss client plays the worker through pg-boss's documented fetch and complete.

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

const browser = () => new TestBrowser(app.fetch, nextIp())

async function firstAdmin() {
  const b = browser()
  expect((await b.setup("first.admin", password)).status).toBe(200)
  await b.enroll(password)
  return b
}

async function agent(admin: TestBrowser) {
  const created = await admin.call("POST", "/api/auth/admin/create-user", {
    email: userEmail("an.agent"),
    password,
    name: "an.agent",
    role: "agent",
    data: { username: "an.agent" },
  })
  expect(created.status).toBe(200)
  const b = browser()
  expect((await b.passwordSignIn("an.agent", password)).status).toBe(200)
  await b.enroll(password)
  return b
}

const output = {
  address: "clamav:3310",
  ok: false,
  failedCheck: "encrypted_pdf",
  version: "ClamAV 1.5.4/1/test",
  checkedAt: "2026-11-12T10:00:00.000Z",
}

describe("the scanner in Settings", () => {
  it("shows the latest self-test to an admin, and refuses an agent", async () => {
    const admin = await firstAdmin()
    expect((await admin.call("GET", "/api/v1/settings/scanner")).json).toEqual({ status: null })
    await database.db.insert(scannerCheck).values({ id: 1, ...output, checkedAt: new Date(output.checkedAt) })
    expect((await admin.call("GET", "/api/v1/settings/scanner")).json).toEqual({ status: output })
    const b = await agent(admin)
    expect((await b.call("GET", "/api/v1/settings/scanner")).status).toBe(403)
    expect((await b.call("POST", "/api/v1/settings/scanner/test")).status).toBe(403)
  })

  it("queues a connection test for the worker and reports its state and result", async () => {
    const admin = await firstAdmin()
    const queued = await admin.call("POST", "/api/v1/settings/scanner/test")
    expect(queued.status).toBe(202)
    const id = queued.json.id as string
    expect((await admin.call("GET", `/api/v1/settings/scanner/test/${id}`)).json).toEqual({
      state: "queued",
      result: null,
    })
    const [job] = await worker.fetch(SCANNER_SELF_TEST)
    expect(job?.id).toBe(id)
    expect((await admin.call("GET", `/api/v1/settings/scanner/test/${id}`)).json.state).toBe("running")
    await worker.complete(SCANNER_SELF_TEST, id, output)
    expect((await admin.call("GET", `/api/v1/settings/scanner/test/${id}`)).json).toEqual({
      state: "done",
      result: output,
    })
    expect((await admin.call("GET", "/api/v1/settings/scanner/test/not-a-job")).status).toBe(404)
    expect((await admin.call("GET", `/api/v1/settings/scanner/test/${crypto.randomUUID()}`)).status).toBe(404)
  })

  it("reports a test whose output is not a self-test as failed", async () => {
    const admin = await firstAdmin()
    const id = (await admin.call("POST", "/api/v1/settings/scanner/test")).json.id as string
    await worker.fetch(SCANNER_SELF_TEST)
    await worker.complete(SCANNER_SELF_TEST, id, { unexpected: true })
    expect((await admin.call("GET", `/api/v1/settings/scanner/test/${id}`)).json).toEqual({
      state: "failed",
      result: null,
    })
  })

  it("queues the self-test when the scanner address changes, and not for other settings", async () => {
    const admin = await firstAdmin()
    expect((await admin.call("PUT", "/api/v1/settings", { "security.sessionDays": 20 })).status).toBe(200)
    expect(await worker.fetch(SCANNER_SELF_TEST)).toEqual([])
    const saved = await admin.call("PUT", "/api/v1/settings", { "scanner.address": "scanner.example.com:3310" })
    expect(saved.status).toBe(200)
    expect(saved.json.settings).toContainEqual(
      expect.objectContaining({ key: "scanner.address", value: "scanner.example.com:3310" }),
    )
    expect(await worker.fetch(SCANNER_SELF_TEST)).toHaveLength(1)
    expect((await admin.call("PUT", "/api/v1/settings", { "scanner.address": "clamav" })).json).toMatchObject({
      error: "setting_invalid",
      key: "scanner.address",
    })
  })
})
