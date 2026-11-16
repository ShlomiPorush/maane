import type { ZendeskTicketRecord, ZendeskUser } from "@maane/zendesk"
import { describe, expect, it } from "vitest"
import {
  commentMessage,
  emailOf,
  fieldDefinitions,
  fieldsOf,
  followersOf,
  linksOf,
  participantsOf,
  statusOf,
} from "./map.ts"

// How a Zendesk record becomes Maane's rows (plan 5.1), without the database. Every record is invented.

const record = (fields: Partial<ZendeskTicketRecord>): ZendeskTicketRecord => ({
  id: 10,
  updated_at: "2025-05-01T09:00:00Z",
  ...fields,
})
const users = new Map<string, ZendeskUser>([
  ["1", { id: 1, name: "Dana Customer", email: "Dana@Example.com", role: "end-user" }],
  ["2", { id: 2, name: "Ron Copy", email: "ron@example.com", role: "end-user" }],
  ["3", { id: 3, name: "No Address", email: null, role: "end-user" }],
  ["4", { id: 4, name: "Avi Agent", email: "avi@example.com", role: "agent" }],
  ["5", { id: 5, name: "Ella Admin", email: "ella@example.com", role: "admin" }],
])

describe("the import's mapping", () => {
  it("maps every Zendesk status 1:1, hold to on hold, and an unknown one to open", () => {
    expect(["new", "open", "pending", "hold", "solved", "closed"].map(statusOf)).toEqual([
      "new",
      "open",
      "pending",
      "on_hold",
      "solved",
      "closed",
    ])
    expect(statusOf("custom_waiting")).toBe("open")
    expect(statusOf(null)).toBe("open")
  })

  it("makes the requester and the CCs participants once each, in lower case, and leaves followers out", () => {
    const ticket = record({ requester_id: 1, email_cc_ids: [2, 3, 1], collaborator_ids: [2], follower_ids: [4] })
    expect(participantsOf(ticket, users)).toEqual([
      { address: "dana@example.com", name: "Dana Customer" },
      { address: "ron@example.com", name: "Ron Copy" },
    ])
    expect(followersOf(ticket, users)).toEqual([{ name: "Avi Agent", address: "avi@example.com" }])
  })

  it("keeps custom fields with a value by their names, a drop-down's value by its option's name", () => {
    const definitions = fieldDefinitions([
      { id: 1, title: "Order" },
      { id: 2, title: "Plan", custom_field_options: [{ name: "Gold plan", value: "plan_gold" }] },
      { id: 3, title: "Topics", custom_field_options: [{ name: "Billing", value: "t_billing" }] },
      { id: 4, title: "Empty" },
    ])
    const ticket = record({
      custom_fields: [
        { id: 1, value: "A-17" },
        { id: 2, value: "plan_gold" },
        { id: 3, value: ["t_billing", "t_other"] },
        { id: 4, value: null },
        { id: 9, value: true },
      ],
    })
    expect(fieldsOf(ticket, definitions)).toEqual([
      { name: "Order", value: "A-17" },
      { name: "Plan", value: "Gold plan" },
      { name: "Topics", value: "Billing, t_other" },
      { name: "#9", value: "true" },
    ])
  })

  it("links merged tickets and follow-ups, once each and never to the ticket itself", () => {
    const ticket = record({
      via: { channel: "web", source: { rel: "follow_up", from: { ticket_id: 7 } } },
      followup_ids: [12, 10],
    })
    const audits = [
      { via: { source: { rel: "merge", from: { ticket_id: 3 } } } },
      { via: { source: { rel: "merge", from: { ticket_ids: [3, 4] } } } },
      { via: { source: { rel: "trigger" } } },
    ]
    expect(linksOf(ticket, audits)).toEqual([
      { zendeskId: 7, reason: "follow_up" },
      { zendeskId: 3, reason: "merged" },
      { zendeskId: 4, reason: "merged" },
      { zendeskId: 12, reason: "follow_up" },
    ])
  })

  it("keeps a comment's email identifiers when Zendesk recorded them, and marks it when it recorded none", () => {
    expect(emailOf({ id: 1 })).toEqual({ kind: "none" })
    expect(
      emailOf({
        id: 2,
        metadata: { system: { message_id: "<abc@mail.example.com>" } },
        via: {
          channel: "email",
          source: {
            from: { address: "Dana@Example.com", name: "Dana", original_recipients: ["help@example.com", "bad"] },
            to: { address: "help@example.com", name: "Help", email_ccs: ["ron@example.com"] },
          },
        },
      }),
    ).toEqual({
      kind: "recorded",
      messageId: "abc@mail.example.com",
      from: { address: "dana@example.com", name: "Dana" },
      to: { address: "help@example.com", name: "Help" },
      cc: ["ron@example.com"],
      originalRecipients: ["help@example.com"],
    })
  })

  it("reads the sender and recipients from metadata.via, as Zendesk's example keeps them, before the comment's via", () => {
    // The shape of Zendesk's List Comments example: the via object inside metadata, beside system, and none at the top.
    const documented = {
      id: 1274,
      author_id: 123123,
      body: "Thanks for your help!",
      public: true,
      metadata: {
        system: { client: "Mozilla/5.0", ip_address: "192.0.2.10", location: "Example City" },
        via: {
          channel: "email",
          source: {
            from: { address: "Customer@Example.com", name: "Customer", original_recipients: ["help@example.com"] },
            rel: null,
            to: { address: "help@example.com", name: "Help", email_ccs: ["ron@example.com"] },
          },
        },
      },
    }
    expect(emailOf(documented)).toEqual({
      kind: "recorded",
      messageId: null,
      from: { address: "customer@example.com", name: "Customer" },
      to: { address: "help@example.com", name: "Help" },
      cc: ["ron@example.com"],
      originalRecipients: ["help@example.com"],
    })
    const planned = commentMessage(10, documented, users, { files: {} }, new Date("2025-05-01T09:00:00Z"))
    expect(planned.source.channel).toBe("email")
    expect(planned.from).toEqual({ address: "customer@example.com", name: "Customer" })
    // metadata.via first; a value only the comment's via holds still counts.
    expect(
      emailOf({
        id: 2,
        metadata: { via: { channel: "email", source: { from: { address: "first@example.com" } } } },
        via: {
          channel: "web",
          source: { from: { address: "second@example.com" }, to: { address: "help@example.com" } },
        },
      }),
    ).toMatchObject({ from: { address: "first@example.com", name: null }, to: { address: "help@example.com" } })
    // A sender is one pair: a name from metadata.via is never joined to an address from via.
    expect(
      emailOf({
        id: 4,
        metadata: { via: { channel: "email", source: { from: { name: "Only A Name" } } } },
        via: { channel: "email", source: { from: { address: "other@example.com", name: "Other" } } },
      }),
    ).toEqual({ kind: "none" })
    // The example's web comment (empty from and to) recorded no identifiers in either place.
    expect(
      emailOf({
        id: 3,
        metadata: { system: {}, via: { channel: "web", source: { from: {}, rel: "web_widget", to: {} } } },
      }),
    ).toEqual({ kind: "none" })
  })

  it("makes a public end user's comment incoming, an agent's or admin's a reply, a private one a note", () => {
    const at = new Date("2025-05-01T09:00:00Z")
    const manifest = { files: {} }
    const as = (author_id: number, isPublic = true) =>
      commentMessage(10, { id: author_id, author_id, public: isPublic, body: "Hi" }, users, manifest, at)
    expect([as(1).direction, as(4).direction, as(5).direction, as(1, false).direction, as(99).direction]).toEqual([
      "in",
      "out",
      "out",
      "note",
      "in",
    ])
    // An author without an address has no sender address; the name stays in the source.
    const noAddress = as(3)
    expect(noAddress.from).toBeNull()
    expect(noAddress.source.author.name).toBe("No Address")
  })
})
