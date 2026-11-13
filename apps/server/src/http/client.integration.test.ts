import type { AddressInfo } from "node:net"
import { serve } from "@hono/node-server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { auditLog } from "../db/schema.ts"
import { createTestApp } from "../testing/app.ts"
import { TEST_ORIGIN, TestBrowser, testPassword } from "../testing/browser.ts"
import { createTestDatabase } from "../testing/db.ts"

// The audit log's client address (foundation "Client address"): the same rule as the link routes. The app is served on
// a port of 127.0.0.1, so each request has a TCP peer; the test browser sends X-Forwarded-For with its own address.

let database: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createTestApp>
let server: ReturnType<typeof serve> | null = null
const password = testPassword()
const FORWARDED = "192.0.2.77"

beforeEach(async () => {
  database = await createTestDatabase()
})
afterEach(async () => {
  server?.close()
  server = null
  await app.close()
  await database.drop()
})

/** A browser whose requests reach the app through a real socket on 127.0.0.1. */
async function browserThroughPort(trustedProxies: string[]): Promise<TestBrowser> {
  app = createTestApp(database, {}, undefined, "/nonexistent", { trustedProxies })
  await app.ready
  const port = await new Promise<number>((resolve) => {
    const s = serve({ fetch: app.app.fetch, port: 0, hostname: "127.0.0.1" }, () =>
      resolve((s.address() as AddressInfo).port),
    )
    server = s
  })
  const through = async (request: Request) => {
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
    return fetch(request.url.replace(TEST_ORIGIN, `http://127.0.0.1:${port}`), {
      method: request.method,
      headers: request.headers,
      body,
      redirect: "manual",
    })
  }
  return new TestBrowser(through, FORWARDED)
}

/** Sets up the first admin, enrolls two-factor, and changes a setting: audit rows from Better Auth and from Maane. */
async function act(b: TestBrowser) {
  expect((await b.setup("first.admin", password)).status).toBe(200)
  await b.enroll(password)
  expect((await b.call("PUT", "/api/v1/settings", { "security.sessionDays": 7 })).status).toBe(200)
  const rows = await database.db.select({ action: auditLog.action, ip: auditLog.ipAddress }).from(auditLog)
  expect(rows.map((row) => row.action)).toEqual(expect.arrayContaining(["account.setup", "setting.update"]))
  return rows
}

describe("the client address of the audit log", () => {
  it("ignores a forwarding header from a peer that is not a trusted proxy", async () => {
    const rows = await act(await browserThroughPort([]))
    expect(new Set(rows.map((row) => row.ip))).toEqual(new Set(["127.0.0.1"]))
  })

  it("takes the forwarded address behind a trusted proxy, in Better Auth's audit rows and Maane's alike", async () => {
    const rows = await act(await browserThroughPort(["127.0.0.1"]))
    expect(new Set(rows.map((row) => row.ip))).toEqual(new Set([FORWARDED]))
  })
})
