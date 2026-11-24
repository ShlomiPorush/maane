import { createECDH, randomBytes } from "node:crypto"
import { userEmail } from "@maane/shared"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { pushSubscription } from "../db/schema.ts"
import { createTestApp } from "../testing/app.ts"
import { nextIp, TestBrowser, testPassword } from "../testing/browser.ts"
import { createTestDatabase } from "../testing/db.ts"

let database: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createTestApp>
const password = testPassword()
const publicKey = randomBytes(65).toString("base64url")

beforeEach(async () => {
  database = await createTestDatabase()
  app = createTestApp(database, {}, undefined, undefined, {}, publicKey)
  await app.ready
})
afterEach(async () => {
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

async function agent(admin: TestBrowser, name: string) {
  const created = await admin.call("POST", "/api/auth/admin/create-user", {
    email: userEmail(name),
    password,
    name,
    role: "agent",
    data: { username: name },
  })
  expect(created.status).toBe(200)
  const b = browser()
  expect((await b.passwordSignIn(name, password)).status).toBe(200)
  await b.enroll(password)
  return b
}

function subscription() {
  const curve = createECDH("prime256v1")
  curve.generateKeys()
  return {
    endpoint: `https://updates.push.services.mozilla.com/wpush/v2/${randomBytes(24).toString("base64url")}`,
    keys: { p256dh: curve.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  }
}

const rows = () => database.db.select().from(pushSubscription)
const state = (b: TestBrowser, endpoint: string | null) => b.call("POST", "/api/v1/notifications/state", { endpoint })

describe("notification routes", () => {
  it("keeps a device's subscription as the signed-in user's, reports it, and removes it", async () => {
    const admin = await firstAdmin()
    const device = subscription()
    expect(await state(admin, null)).toEqual({ status: 200, json: { publicKey, on: false } })
    expect(await state(admin, device.endpoint)).toEqual({ status: 200, json: { publicKey, on: false } })

    const put = await admin.call("PUT", "/api/v1/notifications/subscription", { ...device, locale: "en" })
    expect(put).toEqual({ status: 200, json: { on: true } })
    const me = (await admin.call("GET", "/api/v1/me")).json as { id: string }
    const [row] = await rows()
    expect(row).toMatchObject({ userId: me.id, endpoint: device.endpoint, ...device.keys, locale: "en" })
    expect(await state(admin, device.endpoint)).toEqual({ status: 200, json: { publicKey, on: true } })

    const renewed = { ...subscription(), endpoint: device.endpoint }
    await admin.call("PUT", "/api/v1/notifications/subscription", { ...renewed, locale: "he" })
    expect(await rows()).toEqual([expect.objectContaining({ id: row?.id, ...renewed.keys, locale: "he" })])

    expect(await admin.call("DELETE", "/api/v1/notifications/subscription", { endpoint: device.endpoint })).toEqual({
      status: 200,
      json: { on: false },
    })
    expect(await rows()).toHaveLength(0)
  })

  it("never lets a user see, take, change, or delete another user's subscription", async () => {
    const admin = await firstAdmin()
    const other = await agent(admin, "agent.other")
    const device = subscription()
    await admin.call("PUT", "/api/v1/notifications/subscription", { ...device, locale: "he" })
    const [before] = await rows()

    expect((await state(other, device.endpoint)).json).toEqual({ publicKey, on: false })
    const taken = await other.call("PUT", "/api/v1/notifications/subscription", {
      ...subscription(),
      endpoint: device.endpoint,
      locale: "en",
    })
    expect(taken).toEqual({ status: 409, json: { error: "push_endpoint_taken" } })
    expect(await other.call("DELETE", "/api/v1/notifications/subscription", { endpoint: device.endpoint })).toEqual({
      status: 200,
      json: { on: false },
    })
    expect(await rows()).toEqual([before])
  })

  it("keeps only endpoints of the browsers' push services, and only well-formed keys", async () => {
    const admin = await firstAdmin()
    for (const endpoint of [
      "https://127.0.0.1/push",
      "https://localhost/push",
      "https://192.0.2.10/push",
      "https://[2001:db8::1]/push",
      "http://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://updates.push.services.mozilla.com.example.com/wpush",
      "https://example.com/push",
    ]) {
      const answer = await admin.call("PUT", "/api/v1/notifications/subscription", {
        ...subscription(),
        endpoint,
        locale: "he",
      })
      expect(answer, endpoint).toEqual({ status: 400, json: { error: "push_endpoint_refused" } })
    }
    const bad = { ...subscription(), keys: { p256dh: "short", auth: randomBytes(16).toString("base64url") } }
    expect(await admin.call("PUT", "/api/v1/notifications/subscription", { ...bad, locale: "he" })).toEqual({
      status: 400,
      json: { error: "push_subscription_invalid" },
    })
    expect(await admin.call("PUT", "/api/v1/notifications/subscription", { ...subscription(), locale: "fr" })).toEqual({
      status: 400,
      json: { error: "push_subscription_invalid" },
    })
    expect(await rows()).toHaveLength(0)
  })

  it("needs a signed-in user and the CSRF header, and no answer holds an endpoint or a key", async () => {
    const admin = await firstAdmin()
    const device = subscription()
    const body = { ...device, locale: "he" }
    expect((await browser().call("PUT", "/api/v1/notifications/subscription", body)).status).toBe(401)
    expect((await browser().call("POST", "/api/v1/notifications/state", { endpoint: null })).status).toBe(401)
    const noHeader = await admin.call("PUT", "/api/v1/notifications/subscription", body, { "x-maane-request": "0" })
    expect(noHeader).toEqual({ status: 403, json: { error: "csrf_refused" } })
    const noHeaderDelete = await admin.call(
      "DELETE",
      "/api/v1/notifications/subscription",
      { endpoint: device.endpoint },
      { "x-maane-request": "0" },
    )
    expect(noHeaderDelete.status).toBe(403)
    expect(await rows()).toHaveLength(0)

    const answers = [
      await admin.call("PUT", "/api/v1/notifications/subscription", body),
      await state(admin, device.endpoint),
      await admin.call("DELETE", "/api/v1/notifications/subscription", { endpoint: device.endpoint }),
    ]
    for (const answer of answers) {
      const text = JSON.stringify(answer.json)
      for (const secret of [device.endpoint, device.keys.p256dh, device.keys.auth]) expect(text).not.toContain(secret)
    }
  })
})
