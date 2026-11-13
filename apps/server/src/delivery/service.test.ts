import { describe, expect, it } from "vitest"
import { loggedPath } from "../log.ts"
import { eventTime, queueIdOf, webhookEvents } from "./service.ts"

describe("SMTP2GO's queue ID", () => {
  it("is read from the final reply's id= field", () => {
    expect(queueIdOf("250 OK id=1rXyZw-4n3KqF-0e")).toBe("1rXyZw-4n3KqF-0e")
    expect(queueIdOf("250 2.0.0 OK id=abc123 queued")).toBe("abc123")
    expect(queueIdOf("250 OK")).toBeNull()
    expect(queueIdOf("250 OK messageid=abc")).toBeNull()
    expect(queueIdOf(null)).toBeNull()
  })
})

describe("an event's time", () => {
  it("reads ISO 8601 with or without a zone (UTC), and Unix seconds", () => {
    expect(eventTime("2026-11-13T10:00:00Z")?.toISOString()).toBe("2026-11-13T10:00:00.000Z")
    expect(eventTime("2026-11-13 10:00:00")?.toISOString()).toBe("2026-11-13T10:00:00.000Z")
    expect(eventTime("2026-11-13T12:00:00+02:00")?.toISOString()).toBe("2026-11-13T10:00:00.000Z")
    expect(eventTime("2026-11-13T12:00:00.250+0200")?.toISOString()).toBe("2026-11-13T10:00:00.250Z")
    expect(eventTime(1794564000)?.toISOString()).toBe("2026-11-13T10:00:00.000Z")
    expect(eventTime("1794564000")?.toISOString()).toBe("2026-11-13T10:00:00.000Z")
  })

  it("is no time for anything else, so the event is dropped", () => {
    for (const value of ["yesterday", "", "13/11/2026 10:00", "2026-13-45T10:00:00Z", 12, null, undefined, {}])
      expect(eventTime(value), String(value)).toBeNull()
  })
})

describe("the webhook's events", () => {
  const base = { email_id: "1rXyZw-4n3KqF-0e", rcpt: "Dana@Example.com", time: "2026-11-13T10:00:00Z" }

  it("reads delivered, hard and soft bounces, rejections, and spam reports", () => {
    const statuses = [
      { event: "delivered" },
      { event: "bounce", bounce: "hard" },
      { event: "bounce", bounce: "soft" },
      { event: "reject" },
      { event: "spam" },
    ].map((fields) => webhookEvents({ ...base, ...fields, message: "550 no such user" })[0]?.event.status)
    expect(statuses).toEqual(["delivered", "hard_bounce", "soft_bounce", "rejected", "spam"])
    expect(webhookEvents({ ...base, event: "bounce", message: "550 no such user" })[0]).toEqual({
      providerId: "1rXyZw-4n3KqF-0e",
      event: {
        recipient: "dana@example.com",
        status: "hard_bounce",
        at: new Date("2026-11-13T10:00:00Z"),
        detail: "550 no such user",
        source: "webhook",
      },
    })
  })

  it("drops what it does not read: other events, no ID, no recipient, no time it can read", () => {
    for (const fields of [
      { ...base, event: "open" },
      { ...base, event: "processed" },
      { ...base, event: "delivered", email_id: "" },
      { ...base, event: "delivered", email_id: "a b" },
      { ...base, event: "delivered", rcpt: "" },
      { ...base, event: "delivered", time: "soon" },
    ])
      expect(webhookEvents(fields), JSON.stringify(fields)).toEqual([])
    expect(webhookEvents(null)).toEqual([])
    expect(webhookEvents("delivered")).toEqual([])
  })
})

describe("a logged path", () => {
  it("never names a path under /hooks/, however it is written", () => {
    expect(loggedPath("/hooks/smtp2go/secret-part")).toBe("/hooks/[hidden]")
    expect(loggedPath("/%68ooks/smtp2go/secret-part")).toBe("/hooks/[hidden]")
    expect(loggedPath("//hooks/smtp2go/secret-part")).toBe("/hooks/[hidden]")
    expect(loggedPath("/HOOKS/smtp2go/secret-part")).toBe("/hooks/[hidden]")
    expect(loggedPath("/api/v1/tickets")).toBe("/api/v1/tickets")
  })
})
