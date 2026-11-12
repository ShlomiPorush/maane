import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SYSTEM } from "@maane/server/audit"
import { intakeRecord, message, ticket, ticketPendingReference } from "@maane/server/db/schema"
import { INTAKE_PROCESS } from "@maane/server/jobs/queue"
import { REFERENCE_CODE } from "@maane/shared"
import { eq, sql } from "drizzle-orm"
import { PgBoss } from "pg-boss"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { registerJobs } from "../jobs.ts"
import { type StandInClamd, startStandInClamd } from "../testing/clamd.ts"
import { type IntakeHarness, startIntake } from "../testing/intake.ts"
import { mime } from "../testing/mime.ts"

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
    expect(await h.recordOf(reply)).toMatchObject({
      outcome: "joined",
      matchedMessageId: (await h.messageOf(original)).id,
      matchLayer: "header",
    })
    expect(await h.recordOf(stranger)).toMatchObject({ outcome: "new_linked_ticket", reason: "sender_not_participant" })
    expect(await h.recordOf(bounce)).toMatchObject({ outcome: "automated" })
    // Switching to live does not turn records into tickets.
    await h.mode("live")
    await h.processor.run()
    expect(await h.tickets()).toEqual([])
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
