// The rules the admin pages apply before they ask the server: which user actions show, how a setting's text becomes
// its value, and which facts an audit entry names.

import { describe, expect, it } from "vitest"
import { translate } from "../i18n/i18n.tsx"
import { describe as describeEntry } from "./AuditPage.tsx"
import { parseSetting } from "./SettingsPage.tsx"
import { type ListedUser, userActions } from "./UsersPage.tsx"

const user = (over: Partial<ListedUser>): ListedUser => ({
  id: "u2",
  name: "agent.one",
  username: "agent.one",
  role: "agent",
  banned: false,
  twoFactorEnabled: true,
  setupAdmin: false,
  createdAt: "2026-11-11T10:00:00.000Z",
  ...over,
})

describe("user actions", () => {
  it("offers every action on another user", () => {
    expect(userActions(user({}), "u1")).toEqual({
      changeRole: true,
      ban: true,
      unban: false,
      setPassword: true,
      endSessions: true,
    })
  })

  it("never offers to demote or disable the first admin, which the server refuses", () => {
    const first = userActions(user({ id: "u0", role: "admin", setupAdmin: true }), "u1")
    expect(first.changeRole).toBe(false)
    expect(first.ban).toBe(false)
  })

  it("never offers an admin their own role, ban, or session end", () => {
    const own = userActions(user({ id: "u1", role: "admin" }), "u1")
    expect(own).toMatchObject({ changeRole: false, ban: false, unban: false, endSessions: false })
  })

  it("offers Enable, not Disable, on a disabled user", () => {
    expect(userActions(user({ banned: true }), "u1")).toMatchObject({ ban: false, unban: true })
  })
})

describe("settings values", () => {
  it("takes a whole number of days from 1 to 90", () => {
    expect(parseSetting("security.sessionDays", "14")).toBe(14)
    expect(parseSetting("security.sessionDays", " 90 ")).toBe(90)
    for (const text of ["0", "91", "7.5", "", "abc", "-1"])
      expect(parseSetting("security.sessionDays", text)).toBeNull()
  })

  it("takes a known language only", () => {
    expect(parseSetting("general.defaultLocale", "en")).toBe("en")
    expect(parseSetting("general.defaultLocale", "fr")).toBeNull()
  })
})

describe("audit facts", () => {
  const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars)
  const entry = {
    id: 1,
    at: "2026-11-11T10:00:00.000Z",
    actorUserId: "u1",
    actorLabel: "first.admin",
    entityType: "user",
    entityId: "u2",
    details: null,
    ipAddress: "192.0.2.10",
  }

  it("names the user an admin acted on by username, and the new role", () => {
    const facts = describeEntry(
      { ...entry, action: "user.set_role", details: { role: "admin" } },
      new Map([["u2", "agent.one"]]),
      t,
    )
    expect(facts).toEqual([
      { label: "User", value: "agent.one", ltr: true },
      { label: "Role", value: "Admin" },
    ])
  })

  it("names a setting by its label and its new value", () => {
    const facts = describeEntry(
      {
        ...entry,
        action: "setting.update",
        entityType: "setting",
        entityId: "security.sessionDays",
        details: { value: 7 },
      },
      new Map(),
      t,
    )
    expect(facts).toEqual([
      { label: "Setting", value: "Session length (days)", ltr: false },
      { label: "Value", value: "7", ltr: true },
    ])
  })
})
