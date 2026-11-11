import { SETUP_WINDOW_MS, userEmail } from "@maane/shared"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { auditLog, authUser } from "../db/schema.ts"
import { createTestApp } from "../testing/app.ts"
import { nextIp, TestBrowser, testPassword } from "../testing/browser.ts"
import { createTestDatabase } from "../testing/db.ts"
import { ALLOWED_PATHS } from "./auth.ts"

let database: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createTestApp>
const password = testPassword()

beforeEach(async () => {
  database = await createTestDatabase()
  app = createTestApp(database)
  await app.ready
})
afterEach(async () => {
  await database.drop()
})

const browser = () => new TestBrowser(app.fetch, nextIp())

/** The first admin, enrolled: a signed-in browser and the TOTP secret. */
async function firstAdmin(name = "first.admin") {
  const b = browser()
  const created = await b.setup(name, password)
  expect(created.status).toBe(200)
  const secret = await b.enroll(password)
  return { b, secret, name }
}

/** An admin creates a user; that user signs in and enrolls in a new browser. */
async function newUser(admin: TestBrowser, name: string, role: "admin" | "agent") {
  const created = await admin.call("POST", "/api/auth/admin/create-user", {
    email: userEmail(name),
    password,
    name,
    role,
    data: { username: name },
  })
  expect(created.status, JSON.stringify(created.json)).toBe(200)
  const b = browser()
  const signedIn = await b.passwordSignIn(name, password)
  expect(signedIn.status).toBe(200)
  const secret = await b.enroll(password)
  return { b, secret, id: created.json.user.id as string }
}

describe("setup", () => {
  it("creates one admin, marks it, audits it, and closes", async () => {
    expect((await browser().call("GET", "/api/setup/status")).json).toMatchObject({ hasUser: false, open: true })
    const { name } = await firstAdmin()
    const [user] = await database.db.select().from(authUser)
    expect(user).toMatchObject({ username: name, role: "admin", setupAdmin: true })
    expect((await database.db.select().from(auditLog)).map((r) => r.action)).toContain("account.setup")

    expect((await browser().call("GET", "/api/setup/status")).json).toMatchObject({ hasUser: true, open: false })
    const second = await browser().setup("second.admin", password)
    expect(second.status).toBe(403)
    expect(second.json.code).toBe("SETUP_CLOSED")
  })

  it("creates one admin when setup sign-ups race", async () => {
    const answers = await Promise.all(
      ["racer.one", "racer.two", "racer.three", "racer.four"].map((n) => browser().setup(n, password)),
    )
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1)
    const users = await database.db.select().from(authUser)
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ role: "admin", setupAdmin: true })
  })

  it("closes 5 minutes after start, even with no user", async () => {
    app.clock.advance(SETUP_WINDOW_MS - 1000)
    expect((await browser().call("GET", "/api/setup/status")).json.open).toBe(true)
    app.clock.advance(1000)
    expect((await browser().call("GET", "/api/setup/status")).json).toMatchObject({ open: false, hasUser: false })
    expect((await browser().setup("late.admin", password)).status).toBe(403)
    expect(await database.db.select().from(authUser)).toHaveLength(0)
  })

  it("refuses a setup without a username, so the first admin can always sign in again", async () => {
    const res = await browser().call("POST", "/api/auth/sign-up/email", {
      name: "No Name",
      email: userEmail("no.name"),
      password,
    })
    expect(res.json.code).toBe("INVALID_USERNAME")
    expect(await database.db.select().from(authUser)).toHaveLength(0)
  })

  it("refuses a sign-up whose e-mail is not the one derived from the username", async () => {
    const b = browser()
    const res = await b.call("POST", "/api/auth/sign-up/email", {
      name: "x.admin",
      email: "someone@example.com",
      username: "x.admin",
      password,
    })
    expect(res.status).toBe(400)
  })
})

describe("two-factor before anything else", () => {
  it("lets a session without two-factor reach only enrollment and sign-out", async () => {
    const b = browser()
    await b.setup("first.admin", password)
    expect((await b.call("GET", "/api/v1/me")).json).toEqual({ error: "totp_required" })
    for (const path of ["/api/auth/admin/list-users", "/api/auth/list-sessions"]) {
      const res = await b.call("GET", path)
      expect(res.status, path).toBe(403)
      expect(res.json.code).toBe("TOTP_REQUIRED")
    }
    await b.enroll(password)
    expect((await b.call("GET", "/api/v1/me")).json).toMatchObject({ username: "first.admin", role: "admin" })
    expect((await b.call("GET", "/api/auth/admin/list-users")).status).toBe(200)
  })

  it("refuses protected routes without a session (401), not just without two-factor", async () => {
    const res = await browser().call("GET", "/api/auth/admin/list-users")
    expect(res.status).toBe(401)
  })

  it("asks for the code at sign-in and refuses trustDevice", async () => {
    const { secret, name } = await firstAdmin()
    const b = browser()
    const first = await b.passwordSignIn(name, password)
    expect(first.json.twoFactorRedirect).toBe(true)
    expect((await b.call("GET", "/api/v1/me")).status).toBe(401)
    const trusted = await b.call("POST", "/api/auth/two-factor/verify-totp", { code: "000000", trustDevice: true })
    expect(trusted.json.code).toBe("TRUST_DEVICE_UNSUPPORTED")
    await b.verify((await import("../testing/totp.ts")).totp(secret))
    expect((await b.call("GET", "/api/v1/me")).status).toBe(200)
  })

  it("G7, open for the owner: a password-only session of another browser passes once the user enrolls elsewhere", async () => {
    const setupBrowser = browser()
    await setupBrowser.setup("first.admin", password)
    const other = browser()
    expect((await other.passwordSignIn("first.admin", password)).status).toBe(200)
    expect((await other.call("GET", "/api/v1/me")).json).toEqual({ error: "totp_required" })
    await setupBrowser.enroll(password)
    // The check reads the user's flag, not whether this session passed the second factor.
    expect((await other.call("GET", "/api/v1/me")).status).toBe(200)
    // The setup page then signs out the other browsers, which ends it.
    await setupBrowser.call("POST", "/api/auth/revoke-other-sessions", {})
    expect((await other.call("GET", "/api/v1/me")).status).toBe(401)
  })
})

describe("closed route list", () => {
  it("answers 404 to every route outside the list", async () => {
    const { b } = await firstAdmin()
    for (const path of [
      "/api/auth/admin/update-user",
      "/api/auth/admin/remove-user",
      "/api/auth/admin/impersonate-user",
      "/api/auth/delete-user",
      "/api/auth/update-user",
      "/api/auth/sign-in/email",
      "/api/auth/two-factor/get-totp-uri",
    ]) {
      expect((await b.call("POST", path, {})).status, path).toBe(404)
    }
  })

  it("lists only routes Better Auth still has", () => {
    const routes = new Set(
      Object.values(app.auth().api as Record<string, { path?: string }>)
        .map((endpoint) => endpoint.path)
        .filter(Boolean),
    )
    for (const path of ALLOWED_PATHS) expect(routes.has(path), path).toBe(true)
  })
})

describe("roles and admin actions", () => {
  it("creates an agent who cannot reach admin routes or settings", async () => {
    const { b: admin } = await firstAdmin()
    const agent = await newUser(admin, "agent.one", "agent")
    expect((await agent.b.call("GET", "/api/v1/me")).json.role).toBe("agent")
    expect((await agent.b.call("GET", "/api/auth/admin/list-users")).status).toBe(403)
    expect((await agent.b.call("GET", "/api/v1/settings")).status).toBe(403)
    const [row] = await database.db.select().from(authUser).where(eq(authUser.id, agent.id))
    expect(row).toMatchObject({ role: "agent", setupAdmin: false })
  })

  it("refuses a role that is not admin or agent, and a list of roles", async () => {
    const { b: admin } = await firstAdmin()
    for (const role of ["owner", ["admin", "agent"]]) {
      const res = await admin.call("POST", "/api/auth/admin/create-user", {
        email: userEmail("someone"),
        password,
        name: "someone",
        role,
        data: { username: "someone" },
      })
      expect(res.json.code, JSON.stringify(role)).toBe("INVALID_ROLE")
    }
  })

  it("ends every session of a user whose role changed, and the new role holds at once", async () => {
    const { b: admin } = await firstAdmin()
    const agent = await newUser(admin, "agent.two", "agent")
    const res = await admin.call("POST", "/api/auth/admin/set-role", { userId: agent.id, role: "admin" })
    expect(res.status).toBe(200)
    expect((await agent.b.call("GET", "/api/v1/me")).status).toBe(401)
    const actions = (await database.db.select().from(auditLog)).map((r) => r.action)
    expect(actions).toContain("user.set_role")
  })

  it("refuses an admin's own role change and own ban, so the acting admin always stays one", async () => {
    const { b: admin } = await firstAdmin()
    const [me] = await database.db.select().from(authUser)
    const own = await admin.call("POST", "/api/auth/admin/set-role", { userId: me?.id, role: "agent" })
    expect(own.json.code).toBe("OWN_ROLE")
    const ban = await admin.call("POST", "/api/auth/admin/ban-user", { userId: me?.id })
    expect(ban.status).not.toBe(200)
    expect((await database.db.select().from(authUser))[0]).toMatchObject({ role: "admin", banned: false })
  })

  it("the gap, open for the owner: two admins who demote each other at once can leave no admin", async () => {
    const { b: first } = await firstAdmin()
    const second = await newUser(first, "admin.two", "admin")
    const [firstRow] = await database.db.select().from(authUser).where(eq(authUser.username, "first.admin"))
    const answers = await Promise.all([
      first.call("POST", "/api/auth/admin/set-role", { userId: second.id, role: "agent" }),
      second.b.call("POST", "/api/auth/admin/set-role", { userId: firstRow?.id, role: "agent" }),
    ])
    // Pinned as it behaves today: each request sees the other admin, so both may pass. Either outcome is recorded.
    const admins = (await database.db.select().from(authUser)).filter((u) => u.role === "admin")
    expect(answers.filter((a) => a.status === 200).length).toBeGreaterThanOrEqual(1)
    expect(admins.length).toBeLessThanOrEqual(1)
  })

  it("bans: the user's sessions end and sign-in is refused", async () => {
    const { b: admin } = await firstAdmin()
    const agent = await newUser(admin, "agent.three", "agent")
    expect((await admin.call("POST", "/api/auth/admin/ban-user", { userId: agent.id })).status).toBe(200)
    expect((await agent.b.call("GET", "/api/v1/me")).status).toBe(401)
    expect((await browser().passwordSignIn("agent.three", password)).status).not.toBe(200)
  })

  it("refuses a banned user whose sessions were not cleaned up, on every protected route", async () => {
    const { b: admin } = await firstAdmin()
    const other = await newUser(admin, "admin.three", "admin")
    // The ban stored, the session cleanup not done: what a failure between the plugin's two steps leaves.
    await database.db.update(authUser).set({ banned: true }).where(eq(authUser.id, other.id))
    expect((await other.b.call("GET", "/api/v1/me")).status).toBe(401)
    const res = await other.b.call("GET", "/api/auth/admin/list-users")
    expect(res.json.code).toBe("BANNED")
  })

  it("refuses extra fields and a setup marker through create-user's data", async () => {
    const { b: admin } = await firstAdmin()
    const res = await admin.call("POST", "/api/auth/admin/create-user", {
      email: userEmail("sneaky.one"),
      password,
      name: "sneaky.one",
      role: "agent",
      data: { username: "sneaky.one", setupAdmin: true, role: "admin" },
    })
    expect(res.json.code).toBe("INVALID_FIELDS")
  })

  it("ends the sessions of a user whose password an admin set", async () => {
    const { b: admin } = await firstAdmin()
    const agent = await newUser(admin, "agent.four", "agent")
    const res = await admin.call("POST", "/api/auth/admin/set-user-password", {
      userId: agent.id,
      newPassword: testPassword(),
    })
    expect(res.status).toBe(200)
    expect((await agent.b.call("GET", "/api/v1/me")).status).toBe(401)
  })
})

describe("Maane's API", () => {
  it("refuses a change without the page's header or from another origin", async () => {
    const { b } = await firstAdmin()
    const body = { "security.sessionDays": 7 }
    expect((await b.call("PUT", "/api/v1/settings", body, { "x-maane-request": "0" })).status).toBe(403)
    expect((await b.call("PUT", "/api/v1/settings", body, { origin: "https://evil.example.com" })).status).toBe(403)
    const ok = await b.call("PUT", "/api/v1/settings", body)
    expect(ok.status).toBe(200)
    expect(ok.json.settings.find((s: { key: string }) => s.key === "security.sessionDays").value).toBe(7)
  })

  it("limits sign-in attempts to 5 per 5 minutes per address", async () => {
    await firstAdmin()
    const b = browser()
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await b.passwordSignIn("first.admin", "wrong-password-value")).status)
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true)
    expect(codes[5]).toBe(429)
  })
})
