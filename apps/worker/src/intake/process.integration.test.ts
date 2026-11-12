import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SYSTEM } from "@maane/server/audit"
import {
  intakeConversation,
  intakeConversationTicketLink,
  intakeRecord,
  message,
  ticket,
  ticketPendingReference,
} from "@maane/server/db/schema"
import { INTAKE_PROCESS } from "@maane/server/jobs/queue"
import { REFERENCE_CODE } from "@maane/shared"
import { eq, inArray, sql } from "drizzle-orm"
import { PgBoss } from "pg-boss"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { eicar } from "../files/samples.ts"
import { clamdScanner, type Scanner } from "../files/scanner.ts"
import { registerJobs } from "../jobs.ts"
import { type StandInClamd, startStandInClamd } from "../testing/clamd.ts"
import { type IntakeHarness, startIntake } from "../testing/intake.ts"
import { mime } from "../testing/mime.ts"
import { DEPENDENCY_WAIT_MS, IntakeProcessor } from "./process.ts"

let clamd: StandInClamd
let intake: IntakeHarness | null = null

beforeAll(async () => {
  clamd = await startStandInClamd()
})
afterAll(async () => {
  await clamd.close()
})
afterEach(async () => {
  await intake?.close()
  intake = null
})

const SUPPORT = "support@example.com"

/** A harness with one organization whose exact address is the default, in live mode. */
async function live(): Promise<IntakeHarness & { org: string }> {
  intake = await startIntake(clamd)
  const org = await intake.organization("Example Support", [{ value: SUPPORT, isDefault: true }])
  await intake.mode("live")
  return Object.assign(intake, { org })
}

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 12, 8, minutes))

describe("tickets in live mode", () => {
  it("opens a ticket with a number, a reference code, the concrete address, its organization, and its participants", async () => {
    const h = await live()
    const other = await h.organization("Other", [
      { value: "billing@example.com" },
      { value: "*@sales.example.com", kind: "pattern" },
    ])
    const first = h.graph.add(
      mime({ to: "nobody@example.com", cc: `billing@example.com, Ron <ron@example.com>, ${SUPPORT}` }),
      { receivedAt: at(1) },
    )
    const pattern = h.graph.add(mime({ to: "Desk <desk@SALES.example.com>" }), { receivedAt: at(2) })
    const fallback = h.graph.add(mime({ to: "unknown@example.com" }), { receivedAt: at(3) })
    await h.round()
    const one = await h.ticketOf(first)
    // To has no support address; Cc has one: it decides, and the concrete address is kept.
    expect(one).toMatchObject({ organizationId: other, supportAddress: "billing@example.com", status: "new" })
    expect(one?.referenceCode).toMatch(REFERENCE_CODE)
    expect(await h.participantsOf(one?.id ?? "")).toEqual(["dana@example.com", "ron@example.com"])
    expect(await h.ticketOf(pattern)).toMatchObject({ organizationId: other, supportAddress: "desk@sales.example.com" })
    expect(await h.ticketOf(fallback)).toMatchObject({ organizationId: h.org, supportAddress: SUPPORT })
    const numbers = (await h.tickets()).map((row) => row.number)
    expect(numbers).toEqual([numbers[0], (numbers[0] ?? 0) + 1, (numbers[0] ?? 0) + 2])
    expect(await h.recordOf(first)).toMatchObject({ mode: "live", outcome: "new_ticket", ticketId: one?.id })
  })

  it("threads a reply by its headers, then by the body reference code, then by the subject number, and reopens", async () => {
    const h = await live()
    const original = h.graph.add(mime({ messageId: "o1@example.com", subject: "Printer" }), { receivedAt: at(1) })
    await h.round()
    const opened = await h.ticketOf(original)
    expect(opened?.status).toBe("new")
    const byHeader = h.graph.add(mime({ inReplyTo: "o1@example.com", references: ["o1@example.com"] }), {
      receivedAt: at(2),
    })
    const byCode = h.graph.add(
      mime({ subject: "no headers", text: { content: `Thanks.\n\n> Ref: ${opened?.referenceCode}\n` } }),
      { receivedAt: at(3) },
    )
    const bySubject = h.graph.add(mime({ subject: `Re: [#${opened?.number}] Printer` }), { receivedAt: at(4) })
    await h.round()
    expect((await h.recordOf(byHeader))?.matchLayer).toBe("header")
    expect((await h.recordOf(byCode))?.matchLayer).toBe("reference")
    expect((await h.recordOf(bySubject))?.matchLayer).toBe("subject")
    for (const id of [byHeader, byCode, bySubject]) {
      expect((await h.messageOf(id)).ticketId).toBe(opened?.id)
      expect((await h.recordOf(id))?.outcome).toBe("joined")
    }
    expect((await h.ticketOf(original))?.status).toBe("open")
    expect(await h.tickets()).toHaveLength(1)
  })

  it("opens a linked ticket flagged for review when the sender is not a participant, and leaves the old one as it was", async () => {
    const h = await live()
    const original = h.graph.add(mime({ messageId: "o2@example.com" }), { receivedAt: at(1) })
    await h.round()
    const reply = h.graph.add(mime({ from: "Mallory <mallory@example.com>", inReplyTo: "o2@example.com" }), {
      receivedAt: at(2),
    })
    await h.round()
    const old = await h.ticketOf(original)
    const fresh = await h.ticketOf(reply)
    expect(fresh?.id).not.toBe(old?.id)
    expect(fresh?.reviewFlags).toEqual(["sender_not_participant"])
    expect(await h.linksOf(fresh?.id ?? "")).toEqual([{ linkedTicketId: old?.id, reason: "sender_not_participant" }])
    expect(old?.status).toBe("new")
    expect(await h.participantsOf(old?.id ?? "")).toEqual(["dana@example.com"])
    expect(await h.recordOf(reply)).toMatchObject({ outcome: "new_linked_ticket", matchedTicketId: old?.id })
  })

  it("treats a Message-ID on messages of two tickets as ambiguous in the header layer", async () => {
    const h = await live()
    // The same Message-ID, other content, from two people: two messages, two tickets, the second flagged.
    const a = h.graph.add(mime({ messageId: "dup@example.com", text: { content: "one" } }), { receivedAt: at(1) })
    const b = h.graph.add(
      mime({ messageId: "dup@example.com", from: "Ron <ron@example.com>", text: { content: "two" } }),
      { receivedAt: at(2) },
    )
    await h.round()
    expect((await h.messageOf(b)).reviewFlags).toEqual(["reused_message_id"])
    expect((await h.ticketOf(a))?.id).not.toBe((await h.ticketOf(b))?.id)
    const reply = h.graph.add(mime({ inReplyTo: "dup@example.com" }), { receivedAt: at(3) })
    await h.round()
    expect(await h.recordOf(reply)).toMatchObject({ outcome: "new_ticket", matchedTicketId: null })
  })

  it("records a copy from a second rule once, and keeps a reused Message-ID with other content as its own message", async () => {
    const h = await live()
    const raw = mime({ messageId: "twice@example.com", to: `${SUPPORT}, billing@example.com` })
    const first = h.graph.add(raw, { receivedAt: at(1) })
    const copy = h.graph.add(Buffer.from(raw), { receivedAt: at(2) })
    const reused = h.graph.add(mime({ messageId: "twice@example.com", text: { content: "something else" } }), {
      receivedAt: at(3),
    })
    // The same Message-ID, From, and content, but another Date: not a copy.
    const otherDate = h.graph.add(Buffer.from(raw.toString("latin1").replace("10:00:00", "11:00:00"), "latin1"), {
      receivedAt: at(4),
    })
    await h.round()
    const original = await h.messageOf(first)
    expect(await h.messageOf(copy)).toMatchObject({ duplicateOf: original.id, ticketId: null, reviewFlags: [] })
    expect(await h.recordOf(copy)).toMatchObject({ outcome: "copy", matchedTicketId: original.ticketId })
    expect(await h.messageOf(reused)).toMatchObject({ duplicateOf: null, reviewFlags: ["reused_message_id"] })
    expect((await h.messageOf(otherDate)).duplicateOf).toBeNull()
    // Two copies with a Date mailparser cannot parse: no date on either, so the second is a copy.
    const malformed = Buffer.from(
      mime({ messageId: "baddate@example.com" })
        .toString("latin1")
        .replace(/^Date: .*$/m, "Date: someday soon"),
      "latin1",
    )
    const malformedIds = [
      h.graph.add(malformed, { receivedAt: at(9) }),
      h.graph.add(Buffer.from(malformed), { receivedAt: at(10) }),
    ]
    // Two copies without a Date header: equal dates, so the second is a copy.
    const undated = mime({ messageId: "undated@example.com", date: null })
    const undatedIds = [
      h.graph.add(undated, { receivedAt: at(7) }),
      h.graph.add(Buffer.from(undated), { receivedAt: at(8) }),
    ]
    // A message without a Message-ID is never a copy.
    const bare = mime({ messageId: null })
    const noId = [h.graph.add(bare, { receivedAt: at(5) }), h.graph.add(Buffer.from(bare), { receivedAt: at(6) })]
    await h.round()
    for (const id of noId) expect((await h.messageOf(id)).duplicateOf).toBeNull()
    const [firstUndated, secondUndated] = await Promise.all(undatedIds.map((id) => h.messageOf(id)))
    expect(firstUndated?.sentAt).toBeNull()
    expect(secondUndated?.duplicateOf).toBe(firstUndated?.id)
    const [firstMalformed, secondMalformed] = await Promise.all(malformedIds.map((id) => h.messageOf(id)))
    expect(firstMalformed?.sentAt).toBeNull()
    expect(secondMalformed?.duplicateOf).toBe(firstMalformed?.id)
  })

  it("never opens, joins, or reopens a ticket for automated mail, and flags a bare MAILER-DAEMON for review", async () => {
    const h = await live()
    const original = h.graph.add(mime({ messageId: "o3@example.com" }), { receivedAt: at(1) })
    await h.round()
    const outOfOffice = h.graph.add(
      mime({ inReplyTo: "o3@example.com", headers: [["Auto-Submitted", "auto-replied"]] }),
      { receivedAt: at(2) },
    )
    const list = h.graph.add(mime({ headers: [["List-Id", "<news.example.com>"]] }), { receivedAt: at(3) })
    const bounce = h.graph.add(
      mime({
        from: "MAILER-DAEMON@example.com",
        report: {
          type: "delivery-status",
          parts: [
            { contentType: "text/plain", body: "Delivery failed." },
            { contentType: "message/delivery-status", body: "Reporting-MTA: dns; mx.example.com" },
            { contentType: "text/rfc822-headers", body: "Message-ID: <sent-9@maane.example.com>" },
          ],
        },
      }),
      { receivedAt: at(4) },
    )
    const suppress = h.graph.add(mime({ headers: [["X-Auto-Response-Suppress", "All"]] }), { receivedAt: at(5) })
    const daemon = h.graph.add(mime({ from: "MAILER-DAEMON@example.com", subject: "hello" }), { receivedAt: at(6) })
    await h.round()
    for (const id of [outOfOffice, list, bounce]) {
      expect((await h.messageOf(id)).ticketId).toBeNull()
      expect(await h.recordOf(id)).toMatchObject({ outcome: "automated", classification: "automated" })
    }
    expect(await h.recordOf(outOfOffice)).toMatchObject({ matchedTicketId: (await h.ticketOf(original))?.id })
    expect((await h.ticketOf(original))?.status).toBe("new")
    expect(await h.messageOf(bounce)).toMatchObject({
      reportOriginalMessageId: "sent-9@maane.example.com",
      automatedReasons: ["delivery_report"],
    })
    expect(await h.recordOf(suppress)).toMatchObject({ outcome: "new_ticket", classification: "customer" })
    expect((await h.ticketOf(daemon))?.reviewFlags).toEqual(["possibly_automated"])
  })
})

describe("missing originals", () => {
  it("joins a reply's ticket when its original arrives later, in a separate round", async () => {
    const h = await live()
    const reply = h.graph.add(mime({ inReplyTo: "late@example.com", references: ["late@example.com"] }), {
      receivedAt: at(5),
    })
    await h.round()
    const opened = await h.ticketOf(reply)
    const pending = await h.database.db
      .select()
      .from(ticketPendingReference)
      .where(eq(ticketPendingReference.ticketId, opened?.id ?? ""))
    expect(pending.map((row) => [row.messageIdHeader, row.resolvedBy])).toEqual([["late@example.com", null]])
    const original = h.graph.add(mime({ messageId: "late@example.com" }), { receivedAt: at(1) })
    await h.round()
    expect((await h.messageOf(original)).ticketId).toBe(opened?.id)
    expect(await h.recordOf(original)).toMatchObject({ outcome: "joined", matchLayer: "original" })
    expect(await h.tickets()).toHaveLength(1)
  })

  it("joins a reply's ticket when its original is stored in the same round but received later", async () => {
    const h = await live()
    const reply = h.graph.add(mime({ inReplyTo: "same-round@example.com" }), { receivedAt: at(1) })
    const original = h.graph.add(mime({ messageId: "same-round@example.com" }), { receivedAt: at(2) })
    await h.round()
    expect((await h.ticketOf(original))?.id).toBe((await h.ticketOf(reply))?.id)
    // The reply was stored first, so it does not wait for the original (review G16): the original joins it late.
    expect(await h.recordOf(original)).toMatchObject({ outcome: "joined", matchLayer: "original" })
    expect(await h.tickets()).toHaveLength(1)
  })

  it("puts two replies and their late original on one ticket, in one round and in separate rounds", async () => {
    for (const rounds of ["one", "separate"] as const) {
      const h = await live()
      const first = h.graph.add(mime({ inReplyTo: `orig-${rounds}@example.com` }), { receivedAt: at(5) })
      if (rounds === "separate") await h.round()
      const second = h.graph.add(mime({ inReplyTo: `orig-${rounds}@example.com` }), { receivedAt: at(6) })
      await h.round()
      const original = h.graph.add(mime({ messageId: `orig-${rounds}@example.com` }), { receivedAt: at(1) })
      await h.round()
      const opened = await h.ticketOf(first)
      expect((await h.ticketOf(second))?.id, rounds).toBe(opened?.id)
      expect((await h.ticketOf(original))?.id, rounds).toBe(opened?.id)
      expect(await h.tickets(), rounds).toHaveLength(1)
      await h.close()
      intake = null
    }
  })

  it("keeps waiting for the real original when a stranger reuses its Message-ID", async () => {
    const h = await live()
    const reply = h.graph.add(mime({ inReplyTo: "real@example.com" }), { receivedAt: at(5) })
    await h.round()
    const danas = await h.ticketOf(reply)
    // Mallory sends a message carrying the Message-ID Dana's ticket waits for.
    const forged = h.graph.add(mime({ messageId: "real@example.com", from: "Mallory <mallory@example.com>" }), {
      receivedAt: at(6),
    })
    await h.round()
    expect((await h.ticketOf(forged))?.id).not.toBe(danas?.id)
    expect((await h.ticketOf(forged))?.reviewFlags).toEqual(["sender_not_participant"])
    // Dana's real original arrives later and still joins her ticket.
    const original = h.graph.add(mime({ messageId: "real@example.com", text: { content: "the real one" } }), {
      receivedAt: at(7),
    })
    await h.round()
    expect((await h.ticketOf(original))?.id).toBe(danas?.id)
    expect(await h.recordOf(original)).toMatchObject({ outcome: "joined", matchLayer: "original" })
  })

  it("opens its own ticket for an original two tickets wait for, linked to both and flagged", async () => {
    const h = await live()
    const fromDana = h.graph.add(mime({ inReplyTo: "shared@example.com" }), { receivedAt: at(5) })
    await h.round()
    const fromRon = h.graph.add(mime({ from: "Ron <ron@example.com>", inReplyTo: "shared@example.com" }), {
      receivedAt: at(6),
    })
    await h.round()
    const one = await h.ticketOf(fromDana)
    const two = await h.ticketOf(fromRon)
    expect(two?.id).not.toBe(one?.id)
    const original = h.graph.add(mime({ messageId: "shared@example.com", from: "Gil <gil@example.com>" }), {
      receivedAt: at(1),
    })
    await h.round()
    const own = await h.ticketOf(original)
    expect([one?.id, two?.id]).not.toContain(own?.id)
    expect(own?.reviewFlags).toEqual(["ambiguous_original"])
    expect((await h.linksOf(own?.id ?? "")).map((link) => link.linkedTicketId).sort()).toEqual(
      [one?.id, two?.id].sort(),
    )
  })
})

describe("listening mode", () => {
  it("records what it would have done, opens no ticket, and takes no number", async () => {
    intake = await startIntake(clamd)
    const h = intake
    const org = await h.organization("Example Support", [{ value: SUPPORT, isDefault: true }])
    const sequence = async () =>
      (await h.database.pool.query("select last_value, is_called from ticket_number_seq")).rows[0]
    const before = await sequence()
    const original = h.graph.add(mime({ messageId: "l1@example.com" }), { receivedAt: at(1) })
    const reply = h.graph.add(mime({ inReplyTo: "l1@example.com" }), { receivedAt: at(2) })
    const stranger = h.graph.add(mime({ from: "Mallory <mallory@example.com>", inReplyTo: "l1@example.com" }), {
      receivedAt: at(3),
    })
    const bounce = h.graph.add(mime({ headers: [["Auto-Submitted", "auto-generated"]] }), { receivedAt: at(4) })
    await h.round()
    expect(await h.tickets()).toEqual([])
    expect(await sequence()).toEqual(before)
    expect(await h.recordOf(original)).toMatchObject({
      mode: "listening",
      outcome: "new_ticket",
      supportAddress: SUPPORT,
      organizationId: org,
      ticketId: null,
    })
    const conversation = (await h.messageOf(original)).conversationId
    expect(conversation).not.toBeNull()
    expect(await h.recordOf(original)).toMatchObject({ conversationId: conversation })
    expect(await h.recordOf(reply)).toMatchObject({
      outcome: "joined",
      conversationId: conversation,
      matchedConversationId: conversation,
      matchLayer: "header",
    })
    expect(await h.recordOf(stranger)).toMatchObject({ outcome: "new_linked_ticket", reason: "sender_not_participant" })
    expect(await h.recordOf(bounce)).toMatchObject({ outcome: "automated" })
    // Switching to live does not turn records into tickets.
    await h.mode("live")
    await h.processor.run()
    expect(await h.tickets()).toEqual([])
  })

  /** Listening mode with a default address, no tickets. */
  async function listening() {
    intake = await startIntake(clamd)
    await intake.organization("Example Support", [{ value: SUPPORT, isDefault: true }])
    return intake
  }

  it("puts two replies to one missing original in one conversation, as live mode would", async () => {
    const h = await listening()
    const first = h.graph.add(mime({ inReplyTo: "lost@example.com" }), { receivedAt: at(1) })
    const second = h.graph.add(mime({ inReplyTo: "lost@example.com" }), { receivedAt: at(2) })
    await h.round()
    const conversation = (await h.messageOf(first)).conversationId
    expect(await h.recordOf(first)).toMatchObject({ outcome: "new_ticket", conversationId: conversation })
    expect(await h.recordOf(second)).toMatchObject({ outcome: "joined", conversationId: conversation })
    const original = h.graph.add(mime({ messageId: "lost@example.com" }), { receivedAt: at(0) })
    await h.round()
    expect(await h.recordOf(original)).toMatchObject({
      outcome: "joined",
      matchLayer: "original",
      conversationId: conversation,
    })
  })

  it("treats a Message-ID in two conversations as ambiguous, as live mode would", async () => {
    const h = await listening()
    h.graph.add(mime({ messageId: "twice@example.com", text: { content: "one" } }), { receivedAt: at(1) })
    h.graph.add(mime({ messageId: "twice@example.com", from: "Ron <ron@example.com>", text: { content: "two" } }), {
      receivedAt: at(2),
    })
    await h.round()
    const reply = h.graph.add(mime({ inReplyTo: "twice@example.com" }), { receivedAt: at(3) })
    await h.round()
    expect(await h.recordOf(reply)).toMatchObject({ outcome: "new_ticket", matchedConversationId: null })
  })

  it("counts everyone of the conversation as a participant, not only the sender of the message replied to", async () => {
    const h = await listening()
    const opened = h.graph.add(mime({ messageId: "o@example.com", cc: "Ron <ron@example.com>" }), { receivedAt: at(1) })
    const ron = h.graph.add(
      mime({ messageId: "r@example.com", from: "Ron <ron@example.com>", inReplyTo: "o@example.com" }),
      {
        receivedAt: at(2),
      },
    )
    const dana = h.graph.add(mime({ inReplyTo: "r@example.com" }), { receivedAt: at(3) })
    await h.round()
    const conversation = (await h.messageOf(opened)).conversationId
    expect(await h.recordOf(ron)).toMatchObject({ outcome: "joined", conversationId: conversation })
    expect(await h.recordOf(dana)).toMatchObject({ outcome: "joined", conversationId: conversation })
  })

  it("records a message with no support address and no default for review", async () => {
    intake = await startIntake(clamd)
    const h = intake
    const id = h.graph.add(mime({ to: "nobody@example.com" }))
    await h.round()
    expect(await h.recordOf(id)).toMatchObject({ outcome: "no_address", supportAddress: null })
    expect((await h.messageOf(id)).reviewFlags).toEqual(["no_default_address"])
  })
})

describe("review round 2", () => {
  it("in listening mode, says a participant's reply would join an existing ticket, and leaves the ticket as it was (G4)", async () => {
    const h = await live()
    const original = h.graph.add(mime({ messageId: "t1@example.com", subject: "Printer" }), { receivedAt: at(1) })
    await h.round()
    const opened = await h.ticketOf(original)
    await h.mode("listening")
    const byHeader = h.graph.add(mime({ messageId: "t2@example.com", inReplyTo: "t1@example.com" }), {
      receivedAt: at(2),
    })
    const byCode = h.graph.add(mime({ subject: "no headers", text: { content: `Ref: ${opened?.referenceCode}` } }), {
      receivedAt: at(3),
    })
    const bySubject = h.graph.add(mime({ subject: `Re: [#${opened?.number}]` }), { receivedAt: at(4) })
    // A listening reply to the listening reply: it still reaches the ticket.
    const deeper = h.graph.add(mime({ inReplyTo: "t2@example.com" }), { receivedAt: at(5) })
    const stranger = h.graph.add(mime({ from: "Mallory <mallory@example.com>", inReplyTo: "t1@example.com" }), {
      receivedAt: at(6),
    })
    await h.round()
    for (const [id, layer] of [
      [byHeader, "header"],
      [byCode, "reference"],
      [bySubject, "subject"],
      [deeper, "header"],
    ] as const)
      expect(await h.recordOf(id), layer).toMatchObject({
        mode: "listening",
        outcome: "joined",
        ticketId: null,
        matchedTicketId: opened?.id,
        matchLayer: layer,
      })
    expect(await h.recordOf(stranger)).toMatchObject({
      outcome: "new_linked_ticket",
      matchedTicketId: opened?.id,
      reason: "sender_not_participant",
    })
    // The ticket did not change: one message, still new, no ticket opened.
    expect(await h.tickets()).toHaveLength(1)
    expect((await h.ticketOf(original))?.status).toBe("new")
    const onTicket = await h.database.db
      .select()
      .from(message)
      .where(eq(message.ticketId, opened?.id ?? ""))
    expect(onTicket).toHaveLength(1)
  })

  it("looks at the first reference codes of a body only, in one query, and still finds a real one (G12)", async () => {
    const h = await live()
    const original = h.graph.add(mime({ messageId: "g12@example.com" }), { receivedAt: at(1) })
    await h.round()
    const code = (await h.ticketOf(original))?.referenceCode ?? ""
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    const candidate = (i: number) => {
      let text = ""
      for (let n = i, k = 0; k < 8; k++, n = Math.floor(n / alphabet.length)) {
        if (k === 4) text += "-"
        text += alphabet[n % alphabet.length]
      }
      return text
    }
    const many = Array.from({ length: 100_000 }, (_, i) => candidate(i + 7)).join(" ")
    const flood = h.graph.add(mime({ subject: "codes", text: { content: many } }), { receivedAt: at(2) })
    const found = h.graph.add(mime({ subject: "a real code", text: { content: `AAAA-AAAB ${code} ${many}` } }), {
      receivedAt: at(3),
    })
    await h.sync.run()
    const started = Date.now()
    expect(await h.processor.run()).toEqual({ processed: 2, failed: 0 })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await h.recordOf(flood)).toMatchObject({ outcome: "new_ticket" })
    expect(await h.recordOf(found)).toMatchObject({ outcome: "joined", matchLayer: "reference" })
  }, 60_000)

  it("classifies from the parsed headers even when the header block is blocked (G13)", async () => {
    const h = await live()
    const original = h.graph.add(mime({ messageId: "g13@example.com" }), { receivedAt: at(1) })
    await h.round()
    const auto = h.graph.add(
      mime({
        inReplyTo: "g13@example.com",
        headers: [
          ["Auto-Submitted", "auto-replied"],
          ["X-Anything", eicar().toString("latin1")],
        ],
      }),
      { receivedAt: at(2) },
    )
    await h.round()
    expect(await h.messageOf(auto)).toMatchObject({ headers: [], classification: "automated", ticketId: null })
    expect(await h.recordOf(auto)).toMatchObject({ outcome: "automated" })
    expect((await h.ticketOf(original))?.status).toBe("new")
  })

  it("makes a reply wait for its stored original that waits for the scanner, in live and listening mode (G15)", async () => {
    for (const mode of ["live", "listening"] as const) {
      const state = { down: true }
      const scanner: Scanner = {
        ...clamdScanner,
        scan: async (address, bytes, deadline) =>
          state.down && Buffer.from(bytes).includes("HOLD-ORIGINAL")
            ? { kind: "error" }
            : clamdScanner.scan(address, bytes, deadline),
      }
      intake = await startIntake(clamd, {}, { scanner })
      const h = intake
      await h.organization("Example Support", [{ value: SUPPORT, isDefault: true }])
      if (mode === "live") await h.mode("live")
      const original = h.graph.add(
        mime({ messageId: "dana@example.com", cc: "Ron <ron@example.com>", text: { content: "HOLD-ORIGINAL" } }),
        { receivedAt: at(1) },
      )
      const ron = h.graph.add(mime({ from: "Ron <ron@example.com>", inReplyTo: "dana@example.com" }), {
        receivedAt: at(2),
      })
      await h.round()
      // The original waits for the scanner, and Ron's reply waits for the original.
      expect((await h.messageOf(original)).state, mode).toBe("stored")
      expect((await h.messageOf(ron)).state, mode).toBe("stored")
      state.down = false
      await h.retry.run()
      await h.processor.run()
      const thread = async (id: string) => {
        const row = await h.messageOf(id)
        return mode === "live" ? row.ticketId : row.conversationId
      }
      expect(await thread(ron), mode).toBe(await thread(original))
      expect(await h.recordOf(ron), mode).toMatchObject({ outcome: "joined" })
      await h.close()
      intake = null
    }
  })

  it("stops a reply waiting an hour after the reply was stored, whatever an attacker keeps sending (G15, G16)", async () => {
    const state = { down: true }
    const scanner: Scanner = {
      ...clamdScanner,
      scan: async (address, bytes, deadline) =>
        state.down && Buffer.from(bytes).includes("ATTACK")
          ? { kind: "error" }
          : clamdScanner.scan(address, bytes, deadline),
    }
    intake = await startIntake(clamd, {}, { scanner })
    const h = intake
    await h.organization("Example Support", [{ value: SUPPORT, isDefault: true }])
    await h.mode("live")
    const original = h.graph.add(mime({ messageId: "thread@example.com" }), { receivedAt: at(1) })
    await h.round()
    const opened = await h.ticketOf(original)
    // Mallory sends records with the thread's Message-ID that wait for the scanner, before and after Dana's reply.
    const attack = (n: number) =>
      h.graph.add(
        mime({
          messageId: "thread@example.com",
          from: "Mallory <mallory@example.com>",
          text: { content: `ATTACK ${n}` },
        }),
        { receivedAt: at(2 + n) },
      )
    const before = [attack(1), attack(2)]
    await h.sync.run()
    const reply = h.graph.add(mime({ inReplyTo: "thread@example.com" }), { receivedAt: at(10) })
    await h.sync.run()
    // Right after storing, the reply waits for the attack records stored before it.
    expect(await h.processor.run()).toEqual({ processed: 0, failed: 0 })
    expect((await h.messageOf(reply)).state).toBe("stored")
    // Mallory goes on: one more pair, stored just before the clock below, every few minutes.
    const after = [attack(3), attack(4)]
    await h.sync.run()
    const storedAt = (await h.messageOf(reply)).createdAt.getTime()
    const later = new Date(storedAt + DEPENDENCY_WAIT_MS + 60_000)
    await h.database.db
      .update(message)
      .set({ createdAt: new Date(later.getTime() - 2 * 60_000) })
      .where(inArray(message.graphId, after))
    // The first pair stays stored strictly before the reply and still waits for the scanner: only the reply's own
    // one-hour limit can release it.
    for (const id of before) {
      const row = await h.messageOf(id)
      expect(row.state).toBe("stored")
      expect(row.createdAt.getTime()).toBeLessThan(storedAt)
    }
    // An hour after the reply was stored, it is processed whatever arrived meanwhile.
    const clock = new IntakeProcessor({ db: h.database.db, now: () => later })
    expect((await clock.run()).processed).toBe(1)
    expect((await h.messageOf(reply)).ticketId).toBe(opened?.id)
    for (const id of before) expect((await h.messageOf(id)).state).toBe("stored")
  })

  it("keeps listening pending references of a ticket in the shadow, and matches them as live mode would (G4)", async () => {
    const h = await live()
    const original = h.graph.add(mime({ messageId: "g4-open@example.com" }), { receivedAt: at(1) })
    await h.round()
    const opened = await h.ticketOf(original)
    await h.mode("listening")
    // Dana's mail refers to a missing original M and carries the ticket's code: it would join the ticket.
    const first = h.graph.add(
      mime({ inReplyTo: "missing-m@example.com", text: { content: `Ref: ${opened?.referenceCode}` } }),
      { receivedAt: at(2) },
    )
    await h.round()
    expect(await h.recordOf(first)).toMatchObject({
      outcome: "joined",
      matchedTicketId: opened?.id,
      matchLayer: "reference",
    })
    // A second mail from her names only M: it would join the ticket through the pending reference.
    const second = h.graph.add(mime({ inReplyTo: "missing-m@example.com" }), { receivedAt: at(3) })
    await h.round()
    expect(await h.recordOf(second)).toMatchObject({
      outcome: "joined",
      matchedTicketId: opened?.id,
      matchLayer: "header",
    })
    // The late original M would join the ticket too.
    const late = h.graph.add(mime({ messageId: "missing-m@example.com" }), { receivedAt: at(4) })
    await h.round()
    expect(await h.recordOf(late)).toMatchObject({
      outcome: "joined",
      matchedTicketId: opened?.id,
      matchLayer: "original",
    })
    // The ticket's own pending references were never touched, and no conversation was opened.
    expect(await h.database.db.select().from(ticketPendingReference)).toEqual([])
    expect(await h.database.db.select().from(intakeConversation)).toEqual([])
  })

  it("links a listening conversation to every ticket that waited for an ambiguous original (G17)", async () => {
    const h = await live()
    const fromDana = h.graph.add(mime({ inReplyTo: "g17@example.com" }), { receivedAt: at(1) })
    await h.round()
    const fromRon = h.graph.add(mime({ from: "Ron <ron@example.com>", inReplyTo: "g17@example.com" }), {
      receivedAt: at(2),
    })
    await h.round()
    const one = await h.ticketOf(fromDana)
    const two = await h.ticketOf(fromRon)
    await h.mode("listening")
    const original = h.graph.add(mime({ messageId: "g17@example.com", from: "Gil <gil@example.com>" }), {
      receivedAt: at(3),
    })
    await h.round()
    const conversation = (await h.messageOf(original)).conversationId ?? ""
    expect(await h.recordOf(original)).toMatchObject({
      outcome: "new_linked_ticket",
      reason: "ambiguous_original",
      conversationId: conversation,
    })
    const [shadow] = await h.database.db
      .select()
      .from(intakeConversation)
      .where(eq(intakeConversation.id, conversation))
    expect(shadow?.reviewFlags).toEqual(["ambiguous_original"])
    const links = await h.database.db
      .select()
      .from(intakeConversationTicketLink)
      .where(eq(intakeConversationTicketLink.conversationId, conversation))
    expect(links.map((link) => [link.ticketId, link.reason]).sort()).toEqual(
      [
        [one?.id, "ambiguous_original"],
        [two?.id, "ambiguous_original"],
      ].sort(),
    )
  })
})

describe("the mode, the source, and the queue", () => {
  it("makes a mode switch wait for a processing transaction that read live, and nothing after it reads live", async () => {
    const h = await live()
    const a = h.graph.add(mime(), { receivedAt: at(1) })
    const b = h.graph.add(mime({ from: "Ron <ron@example.com>" }), { receivedAt: at(2) })
    await h.sync.run()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached!: () => void
    const reading = new Promise<void>((resolve) => {
      reached = resolve
    })
    const modes: string[] = []
    const run = h.processor.run({
      afterMode: async (mode) => {
        modes.push(mode)
        if (modes.length === 1) {
          reached()
          await held
        }
      },
    })
    await reading
    let switched = false
    const change = h.mode("listening").then(() => {
      switched = true
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(switched).toBe(false)
    release()
    await change
    await run
    expect(switched).toBe(true)
    expect(modes).toEqual(["live", "listening"])
    expect((await h.ticketOf(a))?.id).toBeDefined()
    expect((await h.messageOf(b)).ticketId).toBeNull()
    expect(await h.recordOf(b)).toMatchObject({ mode: "listening", ticketId: null })
    expect(await h.tickets()).toHaveLength(1)
  })

  it("processes stored messages after the mailbox changed", async () => {
    const h = await live()
    const id = h.graph.add(mime())
    await h.sync.run()
    const other = "after-change@example.com"
    h.graph.allow(other)
    await h.settings.update({ "graph.mailbox": other }, SYSTEM)
    await h.processor.run()
    expect((await h.ticketOf(id))?.id).toBeDefined()
  })

  it("processes what stage one stored at worker start while Graph refuses", async () => {
    const h = await live()
    const ids = [h.graph.add(mime()), h.graph.add(mime({ from: "Ron <ron@example.com>" }))]
    await h.sync.run()
    // The worker stopped after stage one; Graph refuses; the worker starts again.
    h.graph.refuse(true)
    const boss = new PgBoss({ connectionString: h.database.url, schema: "pgboss" })
    await boss.start()
    const dir = await mkdtemp(join(tmpdir(), "maane-heartbeat-"))
    try {
      await registerJobs(boss, {
        heartbeatFile: join(dir, "heartbeat"),
        files: h.files,
        intake: {
          pool: h.database.pool,
          settings: h.settings,
          graph: h.gateway,
          sync: h.sync,
          process: h.processor,
          retry: h.retry,
        },
      })
      await expect
        .poll(async () => (await h.database.db.select().from(intakeRecord)).length, { timeout: 20_000 })
        .toBe(2)
      for (const id of ids) expect((await h.ticketOf(id))?.id).toBeDefined()
      const schedules = (await boss.getSchedules()).map((schedule) => schedule.name)
      expect(schedules).toEqual(expect.arrayContaining([INTAKE_PROCESS, "intake-sync", "intake-files-retry"]))
    } finally {
      await boss.stop({ graceful: false })
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("keeps one processing run at a time", async () => {
    const h = await live()
    h.graph.add(mime())
    await h.sync.run()
    const { runExclusive } = await import("./jobs.ts")
    let inner: unknown
    const outer = await runExclusive(h.database.pool, "test", async () => {
      inner = await runExclusive(h.database.pool, "test", async () => "ran")
      return "outer"
    })
    expect([outer, inner]).toEqual(["outer", { skipped: "running" }])
    const stored = await h.database.db.select({ n: sql<number>`count(*)` }).from(message)
    expect(Number(stored[0]?.n)).toBe(1)
    expect(await h.database.db.select().from(ticket)).toEqual([])
  })
})
