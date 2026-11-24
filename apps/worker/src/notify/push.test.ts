import { MESSAGES } from "@maane/shared"
import { describe, expect, it } from "vitest"
import { notificationOf } from "../intake/process.ts"
import { fromCodePoints } from "../testing/mime.ts"
import { NAME_MAX, pushPayload, shownName } from "./push.ts"

describe("pushPayload", () => {
  it("holds the words with the number, the customer's name, and the number, nothing else", () => {
    expect(pushPayload("en", "new_ticket", 42, "Dana Customer")).toEqual({
      title: MESSAGES.en.notifications.push.newTicket.replace("{number}", "42"),
      body: "Dana Customer",
      number: 42,
    })
    expect(pushPayload("he", "customer_reply", 7, null)).toEqual({
      title: MESSAGES.he.notifications.push.customerReply.replace("{number}", "7"),
      body: "",
      number: 7,
    })
    for (const locale of ["he", "en"] as const)
      for (const words of Object.values(MESSAGES[locale].notifications.push))
        expect(words.replace("{number}", "").includes("{")).toBe(false)
  })

  it("shows a name without hidden or reordering characters, on one line, bounded", () => {
    const rlo = fromCodePoints(0x202e)
    const isolate = fromCodePoints(0x2067)
    expect(shownName(`Dana${rlo} moc.elpmaxe${isolate}\n\tCustomer`)).toBe("Dana moc.elpmaxe Customer")
    expect([...shownName("x".repeat(500))]).toHaveLength(NAME_MAX)
    expect(shownName("   ")).toBe("")
    // A display name that is, or holds, an address shows nothing.
    expect(shownName("dana@example.com")).toBe("")
    expect(shownName("Dana Customer (dana@example.com)")).toBe("")
    expect(pushPayload("en", "new_ticket", 3, "dana@example.com").body).toBe("")
  })
})

describe("notificationOf", () => {
  const live = (outcome: string, classification: string | null = "customer", ticketId: string | null = "t") => ({
    outcome,
    classification,
    ticketId,
  })

  it("notifies for a ticket a message opened, and for exactly what 4.1 counts as a customer reply", () => {
    expect(notificationOf(live("new_ticket"), "m")).toEqual({ kind: "new_ticket", ticketId: "t", messageId: "m" })
    // Among them the follow-up a reply to a closed ticket opens (plan 4.1).
    expect(notificationOf(live("new_linked_ticket"), "m")?.kind).toBe("new_ticket")
    expect(notificationOf(live("joined"), "m")).toEqual({ kind: "customer_reply", ticketId: "t", messageId: "m" })
    // Joined, but not the customer's mail: not a customer reply (isCustomerReply), so nobody is notified.
    for (const classification of ["automated", null])
      expect(notificationOf(live("joined", classification), "m")).toBeNull()
    for (const outcome of ["automated", "copy", "unreadable"]) expect(notificationOf(live(outcome), "m")).toBeNull()
    expect(notificationOf(live("joined", "customer", null), "m")).toBeNull()
    expect(notificationOf(live("new_ticket", "customer", null), "m")).toBeNull()
  })
})
