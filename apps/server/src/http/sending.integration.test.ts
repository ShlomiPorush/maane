import { userEmail } from "@maane/shared"
import { eq } from "drizzle-orm"
import { PgBoss } from "pg-boss"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { auditLog, authUser, organization } from "../db/schema.ts"
import { type JobQueue, openJobQueue, SMTP_TEST } from "../jobs/queue.ts"
import { createTestApp } from "../testing/app.ts"
import { nextIp, TestBrowser, testPassword } from "../testing/browser.ts"
import { createTestDatabase } from "../testing/db.ts"

// The admin parts of sending (plan 3.1): an agent's display name, set through Maane's own endpoint with Better Auth's
// documented server API (its HTTP route /admin/update-user stays closed), an organization's signature, and the SMTP
// connection tests the server only queues (a pg-boss client plays the worker).

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
  return { b, id: created.json.user.id as string }
}

const nameOf = async (id: string) =>
  (await database.db.select({ name: authUser.name }).from(authUser).where(eq(authUser.id, id)))[0]?.name

describe("an agent's display name", () => {
  it("is set by an admin through Maane's endpoint, with an audit row, and nothing else of the user changes", async () => {
    const admin = await firstAdmin()
    const { id } = await agent(admin)
    const before = (await database.db.select().from(authUser).where(eq(authUser.id, id)))[0]
    const answer = await admin.call("PUT", `/api/v1/admin/users/${id}/name`, { name: "  Dana Agent  " })
    expect(answer.status, JSON.stringify(answer.json)).toBe(200)
    const after = (await database.db.select().from(authUser).where(eq(authUser.id, id)))[0]
    expect(after?.name).toBe("Dana Agent")
    expect({ ...after, name: null, updatedAt: null }).toEqual({ ...before, name: null, updatedAt: null })
    const rows = await database.db.select().from(auditLog).where(eq(auditLog.action, "user.rename"))
    expect(rows).toMatchObject([{ entityId: id, details: { name: "Dana Agent" }, actorLabel: "first.admin" }])
  })

  it("refuses an agent, a name that is empty, too long, or hides characters, and an unknown user", async () => {
    const admin = await firstAdmin()
    const { b, id } = await agent(admin)
    expect((await b.call("PUT", `/api/v1/admin/users/${id}/name`, { name: "Me" })).status).toBe(403)
    for (const name of ["", "   ", "x".repeat(81), `a${String.fromCodePoint(0x202e)}b`, "a\nb"])
      expect((await admin.call("PUT", `/api/v1/admin/users/${id}/name`, { name })).json).toEqual({
        error: "name_invalid",
      })
    expect(await nameOf(id)).toBe("an.agent")
    expect((await admin.call("PUT", "/api/v1/admin/users/no-such-user/name", { name: "Ghost" })).status).toBe(404)
  })

  it("keeps Better Auth's own update route closed to browsers", async () => {
    const admin = await firstAdmin()
    const { id } = await agent(admin)
    const direct = await admin.call("POST", "/api/auth/admin/update-user", { userId: id, data: { name: "Direct" } })
    expect(direct.status).toBe(404)
    expect(await nameOf(id)).toBe("an.agent")
  })
})

describe("an organization's signature", () => {
  it("is set by an admin with an audit row, kept as written, and bounded", async () => {
    const admin = await firstAdmin()
    const [org] = await database.db.insert(organization).values({ name: "Example" }).returning()
    const id = org?.id ?? ""
    const signature = "Example Support\r\nexample.com"
    expect((await admin.call("PUT", `/api/v1/admin/organizations/${id}/signature`, { signature })).status).toBe(200)
    expect((await admin.call("GET", `/api/v1/admin/organizations/${id}`)).json.organization.signature).toBe(
      "Example Support\nexample.com",
    )
    expect(
      (await admin.call("PUT", `/api/v1/admin/organizations/${id}/signature`, { signature: "x".repeat(2001) })).json,
    ).toEqual({ error: "signature_invalid", max: 2000 })
    const { b } = await agent(admin)
    expect((await b.call("PUT", `/api/v1/admin/organizations/${id}/signature`, { signature: "x" })).status).toBe(403)
    expect(await database.db.select().from(auditLog).where(eq(auditLog.action, "organization.signature"))).toHaveLength(
      1,
    )
  })
})

describe("the SMTP connection tests", () => {
  it("queue a test of one server for the worker and read its result; agents may not", async () => {
    const admin = await firstAdmin()
    const queued = await admin.call("POST", "/api/v1/settings/smtp/failover/test")
    expect(queued.status).toBe(202)
    const id = queued.json.id as string
    const [job] = await worker.fetch<{ provider: string }>(SMTP_TEST)
    expect(job?.data).toEqual({ provider: "failover" })
    const output = {
      provider: "failover",
      ok: false,
      problem: "auth",
      code: "EAUTH",
      response: "535 5.7.8 Authentication failed",
      checkedAt: "2026-11-13T10:00:00.000Z",
    }
    await worker.complete(SMTP_TEST, id, output)
    expect((await admin.call("GET", `/api/v1/settings/smtp/test/${id}`)).json).toEqual({
      state: "done",
      result: output,
    })
    expect((await admin.call("POST", "/api/v1/settings/smtp/other/test")).status).toBe(404)
    const { b } = await agent(admin)
    expect((await b.call("POST", "/api/v1/settings/smtp/smtp2go/test")).status).toBe(403)
  })

  it("never returns a stored password, and shows the variable that locks a field", async () => {
    const admin = await firstAdmin()
    const secret = testPassword()
    expect((await admin.call("PUT", "/api/v1/settings", { "smtp2go.password": secret })).status).toBe(200)
    const settings = (await admin.call("GET", "/api/v1/settings")).json.settings as {
      key: string
      value: unknown
      set: boolean
    }[]
    expect(settings.find((s) => s.key === "smtp2go.password")).toMatchObject({ value: null, set: true })
    expect(JSON.stringify(settings)).not.toContain(secret)
    expect((await admin.call("PUT", "/api/v1/settings", { "failover.security": "plain" })).json).toMatchObject({
      error: "setting_invalid",
    })
  })
})
