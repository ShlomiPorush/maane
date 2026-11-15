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
  })
})

describe("notificationOf", () => {
  it("notifies for a ticket a customer's message opened or joined, in live mode only", () => {
    expect(notificationOf("live", "new_ticket", "t", "m")).toEqual({
      kind: "new_ticket",
      ticketId: "t",
      messageId: "m",
    })
    expect(notificationOf("live", "new_linked_ticket", "t", "m")?.kind).toBe("new_ticket")
    expect(notificationOf("live", "joined", "t", "m")).toEqual({
      kind: "customer_reply",
      ticketId: "t",
      messageId: "m",
    })
    for (const outcome of ["automated", "copy", "no_address", "unreadable"] as const)
      expect(notificationOf("live", outcome, "t", "m")).toBeNull()
    expect(notificationOf("listening", "new_ticket", "t", "m")).toBeNull()
    expect(notificationOf("live", "joined", null, "m")).toBeNull()
  })
})
