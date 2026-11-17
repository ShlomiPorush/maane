import { userEmail } from "@maane/shared"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { auditLog, organizationMember, setting, supportAddress, ticket } from "../db/schema.ts"
import { createTestApp } from "../testing/app.ts"
import { type Answer, nextIp, TestBrowser, testPassword } from "../testing/browser.ts"
import { createTestDatabase } from "../testing/db.ts"
import { visibleOrganizations } from "./scope.ts"

let database: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createTestApp>
const password = testPassword()

beforeEach(async () => {
  database = await createTestDatabase()
  app = createTestApp(database)
  await app.ready
})
afterEach(async () => {
  await app.close()
  await database.drop()
})

const browser = () => new TestBrowser(app.fetch, nextIp())
const BASE = "/api/v1/admin/organizations"

async function firstAdmin() {
  const b = browser()
  expect((await b.setup("first.admin", password)).status).toBe(200)
  await b.enroll(password)
  const me = await b.call("GET", "/api/v1/me")
  return { b, id: me.json.id as string }
}

/** An admin creates a user, who signs in and enrolls in a browser of their own. */
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
  expect((await b.passwordSignIn(name, password)).status).toBe(200)
  await b.enroll(password)
  return { b, id: created.json.user.id as string }
}

async function createOrganization(admin: TestBrowser, name: string): Promise<string> {
  const res = await admin.call("POST", BASE, { name })
  expect(res.status, JSON.stringify(res.json)).toBe(201)
  return res.json.organization.id
}

async function addAddress(admin: TestBrowser, id: string, kind: "exact" | "pattern", value: string) {
  const res = await admin.call("POST", `${BASE}/${id}/addresses`, { kind, value })
  expect(res.status, JSON.stringify(res.json)).toBe(201)
  return res.json.address.id as string
}

const actions = async () => (await database.db.select().from(auditLog)).map((row) => row.action)

describe("organizations", () => {
  it("creates, renames, lists, and deletes an organization, each write with its audit row", async () => {
    const { b: admin } = await firstAdmin()
    const id = await createOrganization(admin, "  Example Support  ")
    expect((await admin.call("PATCH", `${BASE}/${id}`, { name: "Example Help" })).status).toBe(200)
    const listed = await admin.call("GET", BASE)
    expect(listed.json.organizations).toEqual([
      expect.objectContaining({ id, name: "Example Help", addresses: 0, members: 0, hasDefault: false }),
    ])
    expect((await admin.call("DELETE", `${BASE}/${id}`)).status).toBe(200)
    expect((await admin.call("GET", `${BASE}/${id}`)).status).toBe(404)
    const rows = (await database.db.select().from(auditLog)).filter((r) => r.action.startsWith("organization."))
    expect(rows.map((r) => [r.action, r.details])).toEqual([
      ["organization.create", { name: "Example Support" }],
      ["organization.rename", { name: "Example Help", previous: "Example Support" }],
      ["organization.delete", { name: "Example Help" }],
    ])
    expect(rows.every((r) => r.actorLabel === "first.admin" && r.entityId === id)).toBe(true)
  })

  it("refuses an empty, a too long, or a hidden-character name, and a name taken in another case", async () => {
    const { b: admin } = await firstAdmin()
    for (const name of [
      "",
      "   ",
      "x".repeat(81),
      `a${String.fromCodePoint(0x202e)}b`,
      `a${String.fromCodePoint(0)}b`,
    ]) {
      const res = await admin.call("POST", BASE, { name })
      expect(res.status, JSON.stringify(name)).toBe(400)
      expect(res.json).toMatchObject({ error: "organization_name_invalid", field: "name" })
    }
    expect((await admin.call("POST", BASE, { name: "x".repeat(80) })).status).toBe(201)
    await createOrganization(admin, "Example")
    expect((await admin.call("POST", BASE, { name: "EXAMPLE" })).json).toMatchObject({
      error: "organization_name_taken",
    })
    expect((await admin.call("POST", BASE, { nope: 1 })).json).toEqual({ error: "request_invalid" })
  })

  it("refuses to delete an organization with an address or a member, and writes no audit row for it", async () => {
    const { b: admin } = await firstAdmin()
    const agent = await newUser(admin, "agent.one", "agent")
    const id = await createOrganization(admin, "In use")
    const address = await addAddress(admin, id, "exact", "help@example.com")
    expect((await admin.call("POST", `${BASE}/${id}/members`, { userId: agent.id })).status).toBe(201)
    const before = (await actions()).length
    expect((await admin.call("DELETE", `${BASE}/${id}`)).json).toEqual({
      error: "organization_in_use",
      addresses: 1,
      members: 1,
    })
    expect((await actions()).length).toBe(before)
    expect((await admin.call("DELETE", `${BASE}/${id}/addresses/${address}`)).status).toBe(200)
    expect((await admin.call("DELETE", `${BASE}/${id}`)).json).toMatchObject({ addresses: 0, members: 1 })
    expect((await admin.call("DELETE", `${BASE}/${id}/members/${agent.id}`)).status).toBe(200)
    expect((await admin.call("DELETE", `${BASE}/${id}`)).status).toBe(200)
  })

  it("refuses to delete an organization with mail history, and says so", async () => {
    const { b: admin } = await firstAdmin()
    const id = await createOrganization(admin, "With mail")
    // A ticket of the organization (no address, no member left).
    await database.db
      .insert(ticket)
      .values({ referenceCode: "ABCD-EFGH", organizationId: id, supportAddress: "help@example.com" })
    const before = (await actions()).length
    const refused = await admin.call("DELETE", `${BASE}/${id}`)
    expect(refused.status).toBe(409)
    expect(refused.json).toEqual({ error: "organization_has_mail" })
    expect((await actions()).length).toBe(before)
  })

  it("answers 404 to an id that names nothing, also one that is not a UUID", async () => {
    const { b: admin } = await firstAdmin()
    for (const path of [`${BASE}/not-a-uuid`, `${BASE}/00000000-0000-4000-8000-000000000000`]) {
      expect((await admin.call("GET", path)).json).toEqual({ error: "organization_not_found" })
      expect((await admin.call("PATCH", path, { name: "x" })).status).toBe(404)
      expect((await admin.call("POST", `${path}/addresses`, { kind: "exact", value: "a@example.com" })).status).toBe(
        404,
      )
    }
    const id = await createOrganization(admin, "Example")
    expect((await admin.call("DELETE", `${BASE}/${id}/addresses/nope`)).json).toEqual({ error: "address_not_found" })
  })

  it("is for admins only, and keeps the CSRF header and Origin rules", async () => {
    const { b: admin } = await firstAdmin()
    const agent = await newUser(admin, "agent.one", "agent")
    expect((await agent.b.call("GET", BASE)).json).toEqual({ error: "forbidden" })
    expect((await agent.b.call("POST", BASE, { name: "Mine" })).status).toBe(403)
    expect((await agent.b.call("GET", `${BASE}/address-check?address=a@example.com`)).status).toBe(403)
    expect((await admin.call("POST", BASE, { name: "x" }, { "x-maane-request": "0" })).json).toEqual({
      error: "csrf_refused",
    })
    expect((await admin.call("POST", BASE, { name: "x" }, { origin: "https://evil.example.com" })).status).toBe(403)
    expect((await browser().call("GET", BASE)).status).toBe(401)
  })
})

describe("support addresses", () => {
  it("stores values in lower case, refuses bad syntax with a field error, and a value taken anywhere", async () => {
    const { b: admin } = await firstAdmin()
    const one = await createOrganization(admin, "One")
    const two = await createOrganization(admin, "Two")
    await addAddress(admin, one, "exact", " Help@Example.COM ")
    await addAddress(admin, one, "pattern", "support-*@example.com")
    const shown = await admin.call("GET", `${BASE}/${one}`)
    expect(shown.json.addresses.map((a: { value: string }) => a.value)).toEqual([
      "help@example.com",
      "support-*@example.com",
    ])
    expect(
      (await admin.call("POST", `${BASE}/${one}/addresses`, { kind: "pattern", value: "*@*.example.com" })).json,
    ).toEqual({ error: "pattern_invalid", field: "value" })
    expect(
      (await admin.call("POST", `${BASE}/${one}/addresses`, { kind: "exact", value: "*@example.com" })).json,
    ).toEqual({ error: "address_invalid", field: "value" })
    expect(
      (await admin.call("POST", `${BASE}/${one}/addresses`, { kind: "other", value: "a@example.com" })).json,
    ).toEqual({ error: "request_invalid" })
    expect(
      (await admin.call("POST", `${BASE}/${two}/addresses`, { kind: "exact", value: "HELP@example.com" })).json,
    ).toEqual({ error: "address_taken", field: "value" })
  })

  it("makes only an exact address the default, and moves the default in one step", async () => {
    const { b: admin } = await firstAdmin()
    const one = await createOrganization(admin, "One")
    const two = await createOrganization(admin, "Two")
    const pattern = await addAddress(admin, one, "pattern", "*@example.com")
    const first = await addAddress(admin, one, "exact", "help@example.com")
    const second = await addAddress(admin, two, "exact", "help@two.example.com")
    expect((await admin.call("PUT", `${BASE}/${one}/addresses/${pattern}/default`)).json).toEqual({
      error: "address_default_not_exact",
    })
    expect((await admin.call("PUT", `${BASE}/${one}/addresses/${first}/default`)).status).toBe(200)
    expect((await admin.call("PUT", `${BASE}/${two}/addresses/${second}/default`)).status).toBe(200)
    // An address of another organization is not found through this one.
    expect((await admin.call("PUT", `${BASE}/${one}/addresses/${second}/default`)).status).toBe(404)
    const defaults = await database.db.select().from(supportAddress).where(eq(supportAddress.isDefault, true))
    expect(defaults.map((row) => row.value)).toEqual(["help@two.example.com"])
    const listed = (await admin.call("GET", BASE)).json.organizations
    expect(listed.map((o: { name: string; hasDefault: boolean }) => [o.name, o.hasDefault])).toEqual([
      ["One", false],
      ["Two", true],
    ])
    const moved = (await database.db.select().from(auditLog)).filter((r) => r.action === "organization.address_default")
    expect(moved.map((r) => r.details)).toEqual([
      { name: "One", value: "help@example.com", previous: null },
      { name: "Two", value: "help@two.example.com", previous: "help@example.com" },
    ])
  })

  it("answers which organization gets an address with the same order the intake uses", async () => {
    const { b: admin } = await firstAdmin()
    const one = await createOrganization(admin, "One")
    const two = await createOrganization(admin, "Two")
    await addAddress(admin, one, "pattern", "*@example.com")
    await addAddress(admin, two, "pattern", "support-*@example.com")
    await addAddress(admin, two, "exact", "billing@example.com")
    const check = async (address: string) =>
      (await admin.call("GET", `${BASE}/address-check?address=${encodeURIComponent(address)}`)).json
    expect(await check("Support-Help@example.com")).toMatchObject({
      address: "support-help@example.com",
      via: "pattern",
      organization: { id: two, name: "Two" },
      rule: { kind: "pattern", value: "support-*@example.com" },
    })
    expect(await check("billing@example.com")).toMatchObject({ via: "exact", organization: { name: "Two" } })
    expect(await check("info@example.com")).toMatchObject({ via: "pattern", organization: { name: "One" } })
    expect(await check("info@elsewhere.example.com")).toEqual({
      address: "info@elsewhere.example.com",
      via: "none",
      organization: null,
      rule: null,
    })
    const fallback = await addAddress(admin, one, "exact", "help@example.com")
    await admin.call("PUT", `${BASE}/${one}/addresses/${fallback}/default`)
    expect(await check("info@elsewhere.example.com")).toMatchObject({
      via: "default",
      rule: { value: "help@example.com" },
    })
    expect(await check("not an address")).toEqual({ error: "address_invalid", field: "address" })
  })
})

describe("membership and scope", () => {
  it("adds and removes agents only, and audits both", async () => {
    const { b: admin, id: adminId } = await firstAdmin()
    const agent = await newUser(admin, "agent.one", "agent")
    const id = await createOrganization(admin, "One")
    expect((await admin.call("POST", `${BASE}/${id}/members`, { userId: adminId })).json).toEqual({
      error: "member_not_agent",
    })
    expect((await admin.call("POST", `${BASE}/${id}/members`, { userId: "nobody" })).json).toEqual({
      error: "member_not_agent",
    })
    expect((await admin.call("POST", `${BASE}/${id}/members`, { userId: agent.id })).status).toBe(201)
    expect((await admin.call("POST", `${BASE}/${id}/members`, { userId: agent.id })).json).toEqual({
      error: "member_exists",
    })
    const shown = await admin.call("GET", `${BASE}/${id}`)
    expect(shown.json.members).toEqual([
      expect.objectContaining({ userId: agent.id, username: "agent.one", role: "agent", banned: false }),
    ])
    expect((await admin.call("DELETE", `${BASE}/${id}/members/${agent.id}`)).status).toBe(200)
    expect((await admin.call("DELETE", `${BASE}/${id}/members/${agent.id}`)).json).toEqual({
      error: "member_not_found",
    })
    const rows = (await database.db.select().from(auditLog)).filter((r) => r.action.startsWith("organization.member"))
    expect(rows.map((r) => [r.action, (r.details as { username: string }).username])).toEqual([
      ["organization.member_add", "agent.one"],
      ["organization.member_remove", "agent.one"],
    ])
  })

  it("gives an admin every organization and an agent their own, and drops a removed membership at once", async () => {
    const { b: admin, id: adminId } = await firstAdmin()
    const agent = await newUser(admin, "agent.one", "agent")
    const one = await createOrganization(admin, "One")
    const two = await createOrganization(admin, "Two")
    const db = database.db
    expect(await visibleOrganizations(db, { id: adminId, role: "admin" })).toEqual({ all: true })
    expect(await visibleOrganizations(db, { id: agent.id, role: "agent" })).toEqual({
      all: false,
      organizationIds: [],
    })
    await admin.call("POST", `${BASE}/${one}/members`, { userId: agent.id })
    await admin.call("POST", `${BASE}/${two}/members`, { userId: agent.id })
    expect(await visibleOrganizations(db, { id: agent.id, role: "agent" })).toEqual({
      all: false,
      organizationIds: [one, two].sort(),
    })
    // Removed between two requests: the next read no longer includes it, with nothing cached in between.
    expect((await admin.call("DELETE", `${BASE}/${one}/members/${agent.id}`)).status).toBe(200)
    expect(await visibleOrganizations(db, { id: agent.id, role: "agent" })).toEqual({
      all: false,
      organizationIds: [two],
    })
    expect(await db.select().from(organizationMember)).toHaveLength(1)
  })
})

describe("a role change and memberships", () => {
  const setRole = (admin: TestBrowser, userId: string, role: "admin" | "agent") =>
    admin.call("POST", "/api/auth/admin/set-role", { userId, role })
  const rowsOf = async (userId: string) =>
    database.db.select().from(organizationMember).where(eq(organizationMember.userId, userId))

  it("removes every membership when an agent becomes an admin, audits it, and a demoted admin has none", async () => {
    const { b: admin } = await firstAdmin()
    const agent = await newUser(admin, "agent.one", "agent")
    const one = await createOrganization(admin, "One")
    const two = await createOrganization(admin, "Two")
    await admin.call("POST", `${BASE}/${one}/members`, { userId: agent.id })
    await admin.call("POST", `${BASE}/${two}/members`, { userId: agent.id })
    expect(await rowsOf(agent.id)).toHaveLength(2)

    expect((await setRole(admin, agent.id, "admin")).status).toBe(200)
    expect(await rowsOf(agent.id)).toEqual([])
    const cleared = (await database.db.select().from(auditLog)).filter(
      (row) => row.action === "organization.memberships_clear",
    )
    expect(cleared.map((row) => [row.entityId, row.actorLabel, row.details])).toEqual([
      [agent.id, "first.admin", { username: "agent.one", role: "admin", organizations: 2 }],
    ])
    // An admin is never added.
    expect((await admin.call("POST", `${BASE}/${one}/members`, { userId: agent.id })).json).toEqual({
      error: "member_not_agent",
    })

    // Made an agent again: no old membership comes back, and nothing to audit.
    expect((await setRole(admin, agent.id, "agent")).status).toBe(200)
    expect(await rowsOf(agent.id)).toEqual([])
    expect(await visibleOrganizations(database.db, { id: agent.id, role: "agent" })).toEqual({
      all: false,
      organizationIds: [],
    })
    expect((await actions()).filter((a) => a === "organization.memberships_clear")).toHaveLength(1)
  })

  it("removes the memberships on a demotion too, so a promotion whose clearing failed is repaired", async () => {
    const { b: admin } = await firstAdmin()
    const user = await newUser(admin, "agent.two", "agent")
    const one = await createOrganization(admin, "One")
    expect((await setRole(admin, user.id, "admin")).status).toBe(200)
    // A row left behind, as a failed clearing after the promotion would leave it.
    await database.db.insert(organizationMember).values({ organizationId: one, userId: user.id })
    expect((await setRole(admin, user.id, "agent")).status).toBe(200)
    expect(await rowsOf(user.id)).toEqual([])
  })

  it("never leaves an admin with a membership when adding them and promoting them race", async () => {
    const { b: admin } = await firstAdmin()
    const user = await newUser(admin, "agent.race", "agent")
    const id = await createOrganization(admin, "Race")
    for (let round = 0; round < 6; round++) {
      const add = admin.call("POST", `${BASE}/${id}/members`, { userId: user.id })
      const promote = setRole(admin, user.id, "admin")
      // Both requests are in flight together; the order they were sent in alternates.
      let added: Answer
      let promoted: Answer
      if (round % 2 === 0) [added, promoted] = await Promise.all([add, promote])
      else [promoted, added] = await Promise.all([promote, add])
      expect(promoted.status).toBe(200)
      // Either the membership came first and the promotion removed it, or the promotion came first and adding refused.
      expect([201, 400]).toContain(added.status)
      expect(await rowsOf(user.id), `round ${round}: ${JSON.stringify(added.json)}`).toEqual([])
      expect((await setRole(admin, user.id, "agent")).status).toBe(200)
    }
  })
})

describe("the default address", () => {
  it("is replaceable but never removable, and the intake mode is gone with its row", async () => {
    const { b: admin } = await firstAdmin()
    const id = await createOrganization(admin, "One")
    const first = await addAddress(admin, id, "exact", "help@example.com")
    const second = await addAddress(admin, id, "exact", "support@example.com")
    await admin.call("PUT", `${BASE}/${id}/addresses/${first}/default`)
    expect((await admin.call("DELETE", `${BASE}/${id}/addresses/${first}`)).json).toEqual({
      error: "intake_default_required",
    })
    expect((await admin.call("PUT", `${BASE}/${id}/addresses/${second}/default`)).status).toBe(200)
    expect((await admin.call("DELETE", `${BASE}/${id}/addresses/${first}`)).status).toBe(200)
    expect((await admin.call("DELETE", `${BASE}/${id}/addresses/${second}`)).json).toEqual({
      error: "intake_default_required",
    })
    const defaults = await database.db.select().from(supportAddress).where(eq(supportAddress.isDefault, true))
    expect(defaults.map((row) => row.value)).toEqual(["support@example.com"])
    // No intake mode any more (phase 6): its row is gone, and the settings refuse the key.
    expect(await database.db.select().from(setting).where(eq(setting.key, "intake.mode"))).toEqual([])
    expect((await admin.call("PUT", "/api/v1/settings", { "intake.mode": "live" })).json).toMatchObject({
      error: "setting_unknown",
    })
  })
})
