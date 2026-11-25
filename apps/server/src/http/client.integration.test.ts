import type { AddressInfo } from "node:net"
import { serve } from "@hono/node-server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { auditLog } from "../db/schema.ts"
import { createTestApp } from "../testing/app.ts"
import { TEST_ORIGIN, TestBrowser, testPassword } from "../testing/browser.ts"
import { createTestDatabase } from "../testing/db.ts"

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

async function serveApp(trustedProxies: string[]): Promise<string> {
  app = createTestApp(database, {}, undefined, "/nonexistent", { trustedProxies })
  await app.ready
  const port = await new Promise<number>((resolve) => {
    const s = serve({ fetch: app.app.fetch, port: 0, hostname: "127.0.0.1" }, () =>
      resolve((s.address() as AddressInfo).port),
    )
    server = s
  })
  return `http://127.0.0.1:${port}`
}

async function browserThroughPort(trustedProxies: string[]): Promise<TestBrowser> {
  const base = await serveApp(trustedProxies)
  const through = async (request: Request) => {
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
    const headers = new Headers(request.headers)
    headers.set("x-forwarded-for", FORWARDED)
    return fetch(request.url.replace(TEST_ORIGIN, base), { method: request.method, headers, body, redirect: "manual" })
  }
  return new TestBrowser(through, FORWARDED)
}

async function wrongSignIns(base: string, headersOf: (attempt: number) => Record<string, string>): Promise<number[]> {
  const statuses: number[] = []
  for (let attempt = 1; attempt <= 6; attempt++) {
    const answer = await fetch(`${base}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json", ...headersOf(attempt) },
      body: JSON.stringify({ username: "nobody", password: testPassword() }),
    })
    statuses.push(answer.status)
  }
  return statuses
}

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

describe("the client address of Better Auth's rate limits", () => {
  const LIMITED = [401, 401, 401, 401, 401, 429]

  it("is the peer's when the client reaches the server directly, whatever headers it sends", async () => {
    const base = await serveApp([])
    const forged = (attempt: number) => ({
      "x-forwarded-for": `192.0.2.${attempt}`,
      "x-maane-client-address": `192.0.2.${attempt}`,
    })
    expect(await wrongSignIns(base, forged)).toEqual(LIMITED)
  })

  it("is the forwarded one behind a trusted proxy, each client with its own limit", async () => {
    const base = await serveApp(["127.0.0.1"])
    const forwarded = (address: string) => (attempt: number) => ({
      "x-forwarded-for": `203.0.113.${attempt}, ${address}`,
      "x-maane-client-address": `203.0.113.${attempt}`,
    })
    expect(await wrongSignIns(base, forwarded("192.0.2.10"))).toEqual(LIMITED)
    expect((await wrongSignIns(base, forwarded("192.0.2.11")))[0]).toBe(401)
  })
})
