import { SYSTEM } from "@maane/server/audit"
import { intakeCursor, intakeRecord, message } from "@maane/server/db/schema"
import { Tickets } from "@maane/server/tickets/service"
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { eicar } from "../files/samples.ts"
import { refusedAddress, type StandInClamd, startStandInClamd } from "../testing/clamd.ts"
import { type IntakeHarness, startIntake } from "../testing/intake.ts"
import { mime } from "../testing/mime.ts"
import { MAX_RETRIES_PER_RUN, WaitingFiles } from "./retry.ts"
import { IntakeSync } from "./sync.ts"

const SUPPORT = "support@example.com"

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

async function start(options: { address?: boolean } = {}): Promise<IntakeHarness> {
  intake = await startIntake(clamd)
  if (options.address !== false) await intake.organization("Example Support", [{ value: SUPPORT, isDefault: true }])
  return intake
}

const cursorOf = async (h: IntakeHarness, folder = "inbox") =>
  (await h.database.db.select().from(intakeCursor).where(eq(intakeCursor.folder, folder)))[0]?.link

const rowsOf = (h: IntakeHarness, graphId: string) =>
  h.database.db.select().from(message).where(eq(message.graphId, graphId))

const notRead = async (h: IntakeHarness) =>
  (
    await h.database.db
      .select({ graphId: message.graphId, content: message.content, flags: message.reviewFlags })
      .from(message)
  )
    .filter((row) => row.content === "unavailable" && row.flags.includes("not_read"))
    .map((row) => row.graphId)

const logOf = async (h: IntakeHarness, subject: string) =>
  (await new Tickets(h.database.db, h.dir).intake({ limit: 100 })).entries
    .filter((entry) => entry.subject === subject)
    .map(({ outcome, reasons, flags }) => ({ outcome, reasons, flags }))

const NOT_READ = { outcome: "unreadable", reasons: ["not_read"], flags: ["not_read"] }
const GONE = { outcome: "unreadable", reasons: ["unavailable"], flags: ["unavailable"] }
const TICKET = { outcome: "new_ticket", reasons: [], flags: [] }

async function refusedMessage(h: IntakeHarness, subject = "refused"): Promise<string> {
  const id = h.graph.add(mime({ subject, to: SUPPORT, messageId: `${subject}@example.com` }))
  h.graph.fail(id)
  await h.round()
  expect(await notRead(h)).toEqual([id])
  return id
}

describe("a message Graph does not hand over", () => {
  it.each([400, 403, 500, 504])(
    "is in the log as not read yet after %i, the rest goes on, and it opens its ticket once it is handed over",
    async (status) => {
      const h = await start()
      h.graph.pageSize = 2
      const refused = h.graph.add(mime({ subject: "refused", to: SUPPORT }))
      h.graph.fail(refused, status)
      const rest = Array.from({ length: 4 }, (_, i) => h.graph.add(mime({ subject: `rest ${i}` })))
      const junk = h.graph.add(mime({ subject: "junk" }), { folder: "junkemail" })
      expect(await h.sync.run()).toMatchObject({ status: "done", stored: 6 })
      expect(await cursorOf(h)).toContain("$deltatoken=")
      for (const id of [...rest, junk]) expect((await h.messageOf(id)).content).toBe("parsed")
      expect(await logOf(h, "refused")).toEqual([NOT_READ])
      await h.processor.run()
      expect(await logOf(h, "refused")).toEqual([NOT_READ])
      expect(await h.ticketOf(refused)).toBeUndefined()

      expect(await h.retry.run()).toMatchObject({ messages: 1, stillWaiting: 1 })
      expect(await logOf(h, "refused")).toEqual([NOT_READ])
      h.graph.fail(refused, null)
      expect(await h.retry.run()).toMatchObject({ messages: 1, decided: 1 })
      await h.round()
      expect(await logOf(h, "refused")).toEqual([TICKET])
      expect((await h.ticketOf(refused))?.subject).toBe("refused")
      expect(await rowsOf(h, refused)).toHaveLength(1)
      expect(await h.retry.run()).toMatchObject({ messages: 0 })
      expect(await h.tickets()).toHaveLength(6)
    },
  )

  it("stays not read yet while it is always refused, and other mail flows in every round", async () => {
    const h = await start()
    const refused = await refusedMessage(h)
    for (let round = 0; round < 5; round++) {
      const other = h.graph.add(mime({ subject: `other ${round}` }))
      await h.round()
      expect((await h.ticketOf(other))?.subject).toBe(`other ${round}`)
      expect(await h.retry.run()).toMatchObject({ messages: 1, stillWaiting: 1 })
    }
    expect(await notRead(h)).toEqual([refused])
    expect(await logOf(h, "refused")).toEqual([NOT_READ])
  })

  it("shows in the log also while no default address exists", async () => {
    const h = await start({ address: false })
    const refused = await refusedMessage(h)
    expect(await logOf(h, "refused")).toEqual([NOT_READ])
    h.graph.fail(refused, null)
    await h.retry.run()
    expect(await h.processor.run()).toEqual({ processed: 0, failed: 0 })
    expect((await h.messageOf(refused)).state).toBe("stored")
  })

  it("joins its ticket when its reply came first", async () => {
    const h = await start()
    const refused = await refusedMessage(h, "original")
    const reply = h.graph.add(mime({ subject: "reply", to: SUPPORT, inReplyTo: "original@example.com" }))
    await h.round()
    h.graph.fail(refused, null)
    await h.retry.run()
    await h.round()
    expect((await h.messageOf(refused)).ticketId).toBe((await h.messageOf(reply)).ticketId)
    expect(await logOf(h, "original")).toEqual([{ outcome: "joined", reasons: [], flags: [] }])
  })

  it("opens no ticket before its scans when the scanner is down once it is handed over", async () => {
    const h = await start()
    const refused = await refusedMessage(h)
    h.graph.fail(refused, null)
    await h.settings.update({ "scanner.address": await refusedAddress() }, SYSTEM)
    expect(await h.retry.run()).toMatchObject({ decided: 1 })
    expect(await h.processor.run()).toEqual({ processed: 0, failed: 0 })
    await h.settings.update({ "scanner.address": clamd.address }, SYSTEM)
    expect(await h.retry.run()).toMatchObject({ decided: 1 })
    expect(await h.processor.run()).toEqual({ processed: 1, failed: 0 })
    expect((await h.ticketOf(refused))?.subject).toBe("refused")
  })

  it("is recorded as unreadable when that is what it is once handed over", async () => {
    const h = await start()
    const refused = h.graph.add(Buffer.from(`Subject: broken\r\nX-Long: ${"a".repeat(1_100_000)}\r\n\r\nbody\r\n`))
    h.graph.fail(refused)
    await h.round()
    expect(await logOf(h, "broken")).toEqual([NOT_READ])
    h.graph.fail(refused, null)
    expect(await h.retry.run()).toMatchObject({ decided: 1 })
    await h.round()
    expect(await logOf(h, "broken")).toEqual([
      { outcome: "unreadable", reasons: ["unparsed"], flags: ["parse_failed"] },
    ])
  })

  it("shows no subject the scanner refused", async () => {
    const h = await start()
    h.graph.fail(h.graph.add(mime({ subject: eicar().toString("latin1") })))
    await h.round()
    const [entry] = (await new Tickets(h.database.db, h.dir).intake({ limit: 100 })).entries
    expect(entry).toMatchObject({ subject: null, reasons: ["not_read"], flags: ["blocked_content", "not_read"] })
  })

  it("does not hold up the first mail of a mailbox", async () => {
    const h = await start()
    h.graph.pageSize = 1
    const refused = await refusedMessage(h)
    const second = h.graph.add(mime({ subject: "second" }))
    await h.round()
    expect((await h.ticketOf(second))?.subject).toBe("second")
    expect(await notRead(h)).toEqual([refused])
  })
})

describe("an error that concerns every message", () => {
  it.each([401, 429, 503, 509, "network"] as const)(
    "fails the round when Graph answers every content request with %s, and the cursor stays",
    async (status) => {
      const h = await start()
      await h.round()
      const cursor = await cursorOf(h)
      const ids = Array.from({ length: 3 }, (_, i) => h.graph.add(mime({ subject: `waiting ${i}` })))
      h.graph.failContent(status)
      await expect(h.sync.run()).rejects.toThrow()
      expect(await h.database.db.select().from(message)).toEqual([])
      expect(await cursorOf(h)).toBe(cursor)
      h.graph.failContent(null)
      expect(await h.sync.run()).toMatchObject({ stored: 3 })
      for (const id of ids) expect(await rowsOf(h, id)).toHaveLength(1)
    },
    60_000,
  )

  it.each([400, 403, 500, 504] as const)(
    "loses no message when Graph answers every content request with %s for a while",
    async (status) => {
      const h = await start()
      const ids = Array.from({ length: 3 }, (_, i) => h.graph.add(mime({ subject: `mail ${i}`, to: SUPPORT })))
      h.graph.failContent(status)
      await h.round()
      expect(await h.retry.run()).toMatchObject({ messages: 3, stillWaiting: 3 })
      h.graph.failContent(null)
      expect(await h.retry.run()).toMatchObject({ messages: 3, decided: 3 })
      await h.round()
      for (const [i, id] of ids.entries()) {
        expect(await rowsOf(h, id)).toHaveLength(1)
        expect(await logOf(h, `mail ${i}`)).toEqual([TICKET])
      }
      expect(await h.tickets()).toHaveLength(3)
    },
  )

  it("ends no message while the whole mailbox answers 404, from the middle of a page on", async () => {
    const h = await start()
    const first = h.graph.add(mime({ subject: "first", to: SUPPORT }))
    const second = h.graph.add(mime({ subject: "second", to: SUPPORT }))
    const hold = h.graph.hold(first)
    const round = h.sync.run()
    await hold.reached
    h.graph.loseMailbox(true)
    hold.release()
    await expect(round).rejects.toThrow()
    expect(await notRead(h)).toEqual([second])
    expect(await h.retry.run()).toMatchObject({ messages: 1, stillWaiting: 1 })
    expect(await notRead(h)).toEqual([second])
    h.graph.loseMailbox(false)
    expect(await h.retry.run()).toMatchObject({ decided: 1 })
    await h.round()
    expect(await logOf(h, "first")).toEqual([TICKET])
    expect(await logOf(h, "second")).toEqual([TICKET])
  })
})

describe("a message not read yet that leaves its folder", () => {
  it("is gone once it is deleted for good, and is not asked for again", async () => {
    const h = await start()
    const refused = await refusedMessage(h)
    h.graph.remove(refused)
    h.graph.fail(refused, null)
    expect(await h.retry.run()).toMatchObject({ messages: 1, decided: 1 })
    await h.round()
    expect(await logOf(h, "refused")).toEqual([GONE])
    expect(await h.retry.run()).toMatchObject({ messages: 0 })
    expect(await h.tickets()).toEqual([])
  })

  it("is taken in from another folder once it is handed over", async () => {
    const h = await start()
    const refused = await refusedMessage(h)
    h.graph.trash(refused)
    await h.round()
    expect(await logOf(h, "refused")).toEqual([NOT_READ])
    h.graph.fail(refused, null)
    expect(await h.retry.run()).toMatchObject({ decided: 1 })
    await h.round()
    expect(await logOf(h, "refused")).toEqual([TICKET])
  })
})

describe("restarts, old mailboxes, and work at the same time", () => {
  it("repeats nothing after a stop between the record and the cursor", async () => {
    const h = await start()
    const refused = h.graph.add(mime({ subject: "refused" }))
    h.graph.fail(refused)
    const other = h.graph.add(mime({ subject: "other" }))
    await expect(
      h.sync.run({
        afterMessages: async () => {
          throw new Error("stopped")
        },
      }),
    ).rejects.toThrow("stopped")
    expect(await notRead(h)).toEqual([refused])
    const restarted = new IntakeSync({ db: h.database.db, settings: h.settings, files: h.files, graph: h.gateway })
    expect(await restarted.run()).toMatchObject({ status: "done", stored: 0, skipped: 2 })
    for (const id of [refused, other]) expect(await rowsOf(h, id)).toHaveLength(1)
    expect(await logOf(h, "refused")).toEqual([NOT_READ])
  })

  it("is processed once after a stop between its content and its ticket", async () => {
    const h = await start()
    const refused = await refusedMessage(h)
    h.graph.fail(refused, null)
    await h.retry.run()
    expect(await h.retry.run()).toMatchObject({ messages: 0 })
    await h.sync.run()
    await h.processor.run()
    await h.processor.run()
    expect(await h.database.db.select().from(intakeRecord)).toHaveLength(1)
    expect(await h.tickets()).toHaveLength(1)
  })

  it("is taken in once when two workers ask for it at the same time, also beside a sync round", async () => {
    const h = await start()
    const refused = await refusedMessage(h)
    h.graph.fail(refused, null)
    const parts = { db: h.database.db, settings: h.settings, files: h.files, graph: h.gateway }
    const second = new WaitingFiles({ ...parts, sync: new IntakeSync(parts) })
    const [one, two] = await Promise.all([h.retry.run(), second.run(), h.sync.run()])
    expect(one.decided + two.decided).toBe(1)
    await h.round()
    expect(await rowsOf(h, refused)).toHaveLength(1)
    expect(await h.tickets()).toHaveLength(1)
  })

  it("is not asked for while another mailbox is configured, and resumes when its own is back", async () => {
    const h = await start()
    const refused = await refusedMessage(h)
    h.graph.fail(refused, null)
    const own = h.graph.mailbox
    h.graph.allow("other-intake@example.com")
    await h.settings.update({ "graph.mailbox": "other-intake@example.com" }, SYSTEM)
    expect(await h.retry.run()).toMatchObject({ messages: 0 })
    await h.settings.update({ "graph.mailbox": own }, SYSTEM)
    expect(await h.retry.run()).toMatchObject({ decided: 1 })
  })

  it("is not taken in when another mailbox is configured while its content is on its way", async () => {
    const h = await start()
    const refused = await refusedMessage(h)
    h.graph.fail(refused, null)
    const hold = h.graph.hold(refused)
    const asked = h.retry.run()
    await hold.reached
    h.graph.allow("other-intake@example.com")
    await h.settings.update({ "graph.mailbox": "other-intake@example.com" }, SYSTEM)
    hold.release()
    expect(await asked).toMatchObject({ stillWaiting: 1 })
    expect(await notRead(h)).toEqual([refused])
  })

  it("gives every waiting message and file its turn", async () => {
    const h = await start()
    await h.settings.update({ "scanner.address": await refusedAddress() }, SYSTEM)
    for (let i = 0; i < MAX_RETRIES_PER_RUN; i++) h.graph.fail(h.graph.add(mime({ subject: `refused ${i}` })))
    const recovers = h.graph.add(mime({ subject: "recovers" }))
    h.graph.fail(recovers)
    const file = h.graph.add(mime({ subject: "waiting for the scanner" }))
    await h.round()
    h.graph.fail(recovers, null)
    await h.settings.update({ "scanner.address": clamd.address }, SYSTEM)
    await h.retry.run()
    await h.retry.run()
    expect((await h.messageOf(recovers)).subject).toBe("recovers")
    expect((await h.messageOf(file)).subject).toBe("waiting for the scanner")
    expect(await notRead(h)).toHaveLength(MAX_RETRIES_PER_RUN)
  }, 120_000)
})
