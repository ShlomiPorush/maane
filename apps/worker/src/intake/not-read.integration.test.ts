import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SYSTEM } from "@maane/server/audit"
import { intakeCursor, intakeRecord, message } from "@maane/server/db/schema"
import { INTAKE_FILES_RETRY } from "@maane/server/jobs/queue"
import { Tickets } from "@maane/server/tickets/service"
import { eq } from "drizzle-orm"
import { PgBoss } from "pg-boss"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { eicar } from "../files/samples.ts"
import { registerJobs } from "../jobs.ts"
import { refusedAddress, type StandInClamd, startStandInClamd } from "../testing/clamd.ts"
import { type IntakeHarness, startIntake } from "../testing/intake.ts"
import { mime } from "../testing/mime.ts"
import { IntakeSync, MAX_ASKED_AGAIN_PER_RUN } from "./sync.ts"

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

async function start(options: { address?: boolean; read?: boolean } = {}): Promise<IntakeHarness> {
  intake = await startIntake(clamd)
  if (options.address !== false) await intake.organization("Example Support", [{ value: SUPPORT, isDefault: true }])
  if (options.read !== false) {
    intake.graph.add(mime({ subject: "read before" }))
    await intake.round()
  }
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

async function failingMessage(h: IntakeHarness, subject = "failing", status = 500): Promise<string> {
  const id = h.graph.add(mime({ subject, to: SUPPORT, messageId: `${subject}@example.com` }))
  h.graph.fail(id, status)
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
      const failing = h.graph.add(mime({ subject: "failing", to: SUPPORT }))
      h.graph.fail(failing, status)
      const rest = Array.from({ length: 4 }, (_, i) => h.graph.add(mime({ subject: `rest ${i}` })))
      const junk = h.graph.add(mime({ subject: "junk" }), { folder: "junkemail" })
      expect(await h.sync.run()).toMatchObject({ status: "done", stored: 5, notRead: 1 })
      expect(await cursorOf(h)).toContain("$deltatoken=")
      for (const id of [...rest, junk]) expect((await h.messageOf(id)).content).toBe("parsed")
      expect(await logOf(h, "failing")).toEqual([NOT_READ])
      await h.processor.run()
      expect(await logOf(h, "failing")).toEqual([NOT_READ])
      expect(await h.ticketOf(failing)).toBeUndefined()

      expect(await h.sync.askAgain()).toEqual({ asked: 1, read: 0, gone: 0 })
      expect(await h.sync.run()).toMatchObject({ stored: 0, skipped: 0, notRead: 0 })
      h.graph.fail(failing, null)
      expect(await h.sync.askAgain()).toEqual({ asked: 1, read: 1, gone: 0 })
      await h.round()
      expect(await logOf(h, "failing")).toEqual([{ outcome: "new_ticket", reasons: [], flags: [] }])
      expect((await h.ticketOf(failing))?.subject).toBe("failing")
      expect(await rowsOf(h, failing)).toHaveLength(1)
      expect(await h.sync.askAgain()).toEqual({ asked: 0, read: 0, gone: 0 })
      expect(await h.tickets()).toHaveLength(7)
    },
  )

  it("stays not read yet while it always fails, and other mail flows in every round", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    for (let round = 0; round < 5; round++) {
      const other = h.graph.add(mime({ subject: `other ${round}` }))
      await h.round()
      expect((await h.ticketOf(other))?.subject).toBe(`other ${round}`)
      expect(await h.sync.askAgain()).toEqual({ asked: 1, read: 0, gone: 0 })
    }
    expect(await notRead(h)).toEqual([failing])
    expect(await logOf(h, "failing")).toEqual([NOT_READ])
  })

  it("shows in the log also while no default address exists", async () => {
    const h = await start({ address: false })
    const failing = await failingMessage(h)
    expect(await logOf(h, "failing")).toEqual([NOT_READ])
    h.graph.fail(failing, null)
    await h.sync.askAgain()
    expect(await h.processor.run()).toEqual({ processed: 0, failed: 0 })
    expect((await h.messageOf(failing)).state).toBe("stored")
  })

  it("joins its ticket when its reply came first", async () => {
    const h = await start()
    const failing = await failingMessage(h, "original")
    const reply = h.graph.add(mime({ subject: "reply", to: SUPPORT, inReplyTo: "original@example.com" }))
    await h.round()
    h.graph.fail(failing, null)
    await h.sync.askAgain()
    await h.round()
    expect((await h.messageOf(failing)).ticketId).toBe((await h.messageOf(reply)).ticketId)
    expect(await logOf(h, "original")).toEqual([{ outcome: "joined", reasons: [], flags: [] }])
  })

  it("opens no ticket before its scans when the scanner is down once it is handed over", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    h.graph.fail(failing, null)
    await h.settings.update({ "scanner.address": await refusedAddress() }, SYSTEM)
    expect(await h.sync.askAgain()).toMatchObject({ read: 1 })
    expect(await h.processor.run()).toEqual({ processed: 0, failed: 0 })
    await h.settings.update({ "scanner.address": clamd.address }, SYSTEM)
    expect(await h.retry.run()).toMatchObject({ decided: 1 })
    expect(await h.processor.run()).toEqual({ processed: 1, failed: 0 })
    expect((await h.ticketOf(failing))?.subject).toBe("failing")
  })

  it("is recorded as too large when it is larger than the limit once handed over", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    h.graph.fail(failing, null)
    await h.settings.update({ "files.maxBytes": 1024 * 1024 }, SYSTEM)
    h.graph.replace(failing, mime({ subject: "failing", text: { content: "x".repeat(2_000_000) } }))
    expect(await h.sync.askAgain()).toMatchObject({ read: 1 })
    await h.round()
    expect(await logOf(h, "failing")).toEqual([{ outcome: "unreadable", reasons: ["too_large"], flags: ["too_large"] }])
  })

  it("shows no subject the scanner refused", async () => {
    const h = await start()
    h.graph.fail(h.graph.add(mime({ subject: eicar().toString("latin1") })))
    await h.round()
    const [entry] = (await new Tickets(h.database.db, h.dir).intake({ limit: 100 })).entries
    expect(entry).toMatchObject({ subject: null, reasons: ["not_read"], flags: ["blocked_content", "not_read"] })
  })

  it("is asked for again by the retry job that also scans waiting files", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    h.graph.fail(failing, null)
    const boss = new PgBoss({ connectionString: h.database.url, schema: "pgboss" })
    boss.on("error", () => {})
    await boss.start()
    try {
      await registerJobs(boss, {
        heartbeatFile: join(tmpdir(), `maane-heartbeat-${randomUUID()}`),
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
      await boss.send(INTAKE_FILES_RETRY, {})
      await expect.poll(async () => (await h.messageOf(failing)).content, { timeout: 20_000 }).toBe("parsed")
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 })
    }
  }, 60_000)

  it("is recorded as unreadable when that is what it is once handed over", async () => {
    const h = await start()
    const failing = h.graph.add(Buffer.from(`Subject: broken\r\nX-Long: ${"a".repeat(1_100_000)}\r\n\r\nbody\r\n`))
    h.graph.fail(failing)
    await h.round()
    expect(await logOf(h, "broken")).toEqual([NOT_READ])
    h.graph.fail(failing, null)
    expect(await h.sync.askAgain()).toMatchObject({ read: 1 })
    await h.round()
    expect(await logOf(h, "broken")).toEqual([
      { outcome: "unreadable", reasons: ["unparsed"], flags: ["parse_failed"] },
    ])
    expect(await notRead(h)).toEqual([])
  })
})

describe("an error that concerns every message", () => {
  it.each([400, 401, 403, 429, 500, 503, 504, 509, "network"] as const)(
    "marks no message when Graph answers every content request with %s, and the cursor stays",
    async (status) => {
      const h = await start()
      const cursor = await cursorOf(h)
      const ids = Array.from({ length: 3 }, (_, i) => h.graph.add(mime({ subject: `waiting ${i}` })))
      h.graph.failContent(status)
      await expect(h.sync.run()).rejects.toThrow()
      expect(await notRead(h)).toEqual([])
      expect(await cursorOf(h)).toBe(cursor)
      h.graph.failContent(null)
      expect(await h.sync.run()).toMatchObject({ stored: 3, notRead: 0 })
      for (const id of ids) expect(await rowsOf(h, id)).toHaveLength(1)
    },
    60_000,
  )

  it.each([403, 500, 503] as const)("marks no message when %i starts in the middle of a page", async (status) => {
    const h = await start()
    const cursor = await cursorOf(h)
    for (let i = 0; i < 4; i++) h.graph.add(mime({ subject: `middle ${i}` }))
    h.graph.failContent(status, { after: 2 })
    await expect(h.sync.run()).rejects.toThrow()
    expect(await notRead(h)).toEqual([])
    expect(await cursorOf(h)).toBe(cursor)
    h.graph.failContent(null)
    expect(await h.sync.run()).toMatchObject({ stored: 2, skipped: 2, notRead: 0 })
  })

  it("marks no message when the error ended before the page did", async () => {
    const h = await start()
    for (let i = 0; i < 3; i++) h.graph.add(mime({ subject: `short ${i}` }))
    h.graph.failContent(500, { times: 2 })
    expect(await h.sync.run()).toMatchObject({ status: "done", stored: 3, notRead: 0 })
    expect(await notRead(h)).toEqual([])
  })

  it("marks no message while Graph handed over none before, and tells them apart once it does", async () => {
    const h = await start({ read: false })
    const failing = h.graph.add(mime({ subject: "failing" }))
    h.graph.fail(failing)
    await expect(h.sync.run()).rejects.toThrow()
    expect(await notRead(h)).toEqual([])
    expect(await cursorOf(h)).toBeUndefined()
    const second = h.graph.add(mime({ subject: "second" }))
    expect(await h.sync.run()).toMatchObject({ stored: 1, notRead: 1 })
    expect((await h.messageOf(second)).content).toBe("parsed")
    expect(await notRead(h)).toEqual([failing])
  })

  it("compares with an older message when the newest ones left the mailbox or are too large by now", async () => {
    const h = await start()
    const large = h.graph.add(mime({ text: { content: "x".repeat(2_000_000) } }))
    const removed = h.graph.add(mime({ subject: "removed later" }))
    await h.round()
    h.graph.remove(removed)
    await h.settings.update({ "files.maxBytes": 1024 * 1024 }, SYSTEM)
    expect((await h.messageOf(large)).content).toBe("parsed")
    await failingMessage(h)
  })

  it("compares with a message further back when the newest ones are gone or fail too", async () => {
    const h = await start()
    const newer = Array.from({ length: 10 }, (_, i) => h.graph.add(mime({ subject: `newer ${i}` })))
    await h.round()
    for (const id of newer.slice(0, 5)) h.graph.remove(id)
    for (const id of newer.slice(5)) h.graph.fail(id)
    await failingMessage(h)
  })

  it("waits when its content answers 404 after another error while it is in its folder", async () => {
    const h = await start()
    const failing = h.graph.add(mime({ subject: "failing" }))
    h.graph.fail(failing, 500)
    const hold = h.graph.hold(h.graph.add(mime({ subject: "held" })))
    const round = h.sync.run()
    await hold.reached
    h.graph.fail(failing, 404)
    hold.release()
    expect(await round).toMatchObject({ status: "done", notRead: 1 })
    expect(await notRead(h)).toEqual([failing])
  })

  it("marks and ends nothing when the whole mailbox answers 404 from the middle of a page", async () => {
    const h = await start()
    const cursor = await cursorOf(h)
    const first = h.graph.add(mime({ subject: "first" }))
    h.graph.add(mime({ subject: "second" }))
    const hold = h.graph.hold(first)
    const round = h.sync.run()
    await hold.reached
    h.graph.loseMailbox(true)
    hold.release()
    await expect(round).rejects.toThrow()
    expect(await cursorOf(h)).toBe(cursor)
    expect(await h.database.db.select().from(message).where(eq(message.content, "unavailable"))).toEqual([])
    h.graph.loseMailbox(false)
    expect(await h.sync.run()).toMatchObject({ stored: 1, skipped: 1, notRead: 0 })
  })

  it("marks and ends nothing when the whole mailbox answers 404 right after another message was handed over", async () => {
    const h = await start({ read: false })
    const control = h.graph.add(mime({ subject: "control" }))
    await h.round()
    const cursor = await cursorOf(h)
    h.graph.fail(h.graph.add(mime({ subject: "refused" })))
    const hold = h.graph.hold(control)
    const round = h.sync.run()
    await hold.reached
    h.graph.loseMailbox(true)
    hold.release()
    await expect(round).rejects.toThrow()
    expect(await notRead(h)).toEqual([])
    expect(await cursorOf(h)).toBe(cursor)
  })

  it("ends nothing when the whole mailbox answers 404 while the retry runs", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    const hold = h.graph.hold(failing)
    const asked = h.sync.askAgain()
    await hold.reached
    h.graph.loseMailbox(true)
    h.graph.vanish(failing)
    hold.release()
    await expect(asked).rejects.toThrow()
    expect(await notRead(h)).toEqual([failing])
  })

  it("ends nothing at the retry when the whole mailbox answers 404, and goes on when it is back", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    h.graph.loseMailbox(true)
    await expect(h.sync.askAgain()).rejects.toThrow()
    expect(await notRead(h)).toEqual([failing])
    h.graph.loseMailbox(false)
    h.graph.fail(failing, null)
    expect(await h.sync.askAgain()).toMatchObject({ read: 1 })
  })

  it("stops the retry at the first error that concerns every message", async () => {
    const h = await start()
    for (const subject of ["one", "two"]) h.graph.fail(h.graph.add(mime({ subject })))
    await h.round()
    expect(await notRead(h)).toHaveLength(2)
    h.graph.failContent(503)
    await expect(h.sync.askAgain()).rejects.toThrow()
    const tried = (await h.database.db.select({ at: message.retryAt }).from(message)).filter((row) => row.at !== null)
    expect(tried).toHaveLength(1)
    expect(await notRead(h)).toHaveLength(2)
  })
})

describe("a message not read yet that leaves the mailbox", () => {
  it("is gone when it is deleted for good, and is not asked for again", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    h.graph.remove(failing)
    expect(await h.sync.askAgain()).toEqual({ asked: 1, read: 0, gone: 1 })
    expect(await logOf(h, "failing")).toEqual([GONE])
    await h.round()
    expect(await h.sync.askAgain()).toEqual({ asked: 0, read: 0, gone: 0 })
    expect(await logOf(h, "failing")).toEqual([GONE])
  })

  it("is gone when it is moved to Deleted Items, and waits again when it is restored", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    h.graph.trash(failing)
    await h.round()
    expect(await h.sync.askAgain()).toEqual({ asked: 1, read: 0, gone: 1 })
    expect(await logOf(h, "failing")).toEqual([GONE])
    h.graph.move(failing, "inbox")
    await h.round()
    expect(await logOf(h, "failing")).toEqual([NOT_READ])
    h.graph.fail(failing, null)
    expect(await h.sync.askAgain()).toMatchObject({ read: 1 })
    await h.round()
    expect(await logOf(h, "failing")).toEqual([{ outcome: "new_ticket", reasons: [], flags: [] }])
  })

  it.each([
    ["inbox", "junkemail", true],
    ["inbox", "junkemail", false],
    ["junkemail", "inbox", true],
    ["junkemail", "inbox", false],
  ] as const)("is still read after a move from %s to %s (retry first: %s)", async (from, to, retryFirst) => {
    const h = await start()
    const failing = h.graph.add(mime({ subject: "moved", to: SUPPORT }), { folder: from })
    h.graph.fail(failing)
    await h.round()
    h.graph.move(failing, to)
    if (retryFirst) await h.sync.askAgain()
    await h.round()
    expect(await logOf(h, "moved")).toEqual([NOT_READ])
    h.graph.fail(failing, null)
    expect(await h.sync.askAgain()).toMatchObject({ read: 1 })
    await h.round()
    expect(await h.messageOf(failing)).toMatchObject({ content: "parsed", folder: to })
    expect(await logOf(h, "moved")).toEqual([{ outcome: "new_ticket", reasons: [], flags: [] }])
  })

  it("is gone when it is moved to a folder Maane does not read", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    h.graph.trash(failing)
    expect(await h.sync.askAgain()).toMatchObject({ gone: 1 })
    expect(await logOf(h, "failing")).toEqual([GONE])
  })

  it("keeps waiting in the folder it is in when an older page still lists it in the other one", async () => {
    const h = await start()
    h.graph.pageSize = 1
    h.graph.add(mime({ subject: "first junk" }), { folder: "junkemail" })
    const failing = h.graph.add(mime({ subject: "moved", to: SUPPORT }), { folder: "junkemail" })
    h.graph.fail(failing)
    await h.sync.run({}, 1)
    h.graph.move(failing, "inbox")
    await h.round()
    expect(await notRead(h)).toEqual([failing])
    expect(await h.sync.askAgain()).toEqual({ asked: 1, read: 0, gone: 0 })
    h.graph.fail(failing, null)
    expect(await h.sync.askAgain()).toMatchObject({ read: 1 })
    expect(await h.messageOf(failing)).toMatchObject({ content: "parsed", folder: "inbox" })
  })

  it("waits again when it is restored while an answer that it left is on its way", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    h.graph.trash(failing)
    const hold = h.graph.hold(failing)
    const asked = h.sync.askAgain()
    await hold.reached
    h.graph.move(failing, "inbox")
    await h.sync.run()
    h.graph.remove(failing)
    hold.release()
    expect(await asked).toEqual({ asked: 1, read: 0, gone: 0 })
    expect(await notRead(h)).toEqual([failing])
  })

  it("waits again when it is restored while the scanner retry asks for its metadata", async () => {
    const h = await start()
    await h.settings.update({ "scanner.address": await refusedAddress() }, SYSTEM)
    const failing = h.graph.add(mime({ subject: "failing" }))
    h.graph.fail(failing)
    await h.round()
    h.graph.trash(failing)
    expect(await h.sync.askAgain()).toMatchObject({ gone: 1 })
    const hold = h.graph.hold(failing)
    const scanned = h.retry.run()
    await hold.reached
    h.graph.move(failing, "inbox")
    await h.sync.run()
    h.graph.remove(failing)
    hold.release()
    await scanned
    expect(await notRead(h)).toEqual([failing])
  })

  it("keeps waiting when only its content answers 404 while it is in its folder", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    h.graph.fail(failing, 404)
    expect(await h.sync.askAgain()).toEqual({ asked: 1, read: 0, gone: 0 })
    expect(await notRead(h)).toEqual([failing])
  })
})

describe("restarts, old mailboxes, and work at the same time", () => {
  it("repeats nothing after a stop between the record and the cursor", async () => {
    const h = await start()
    const failing = h.graph.add(mime({ subject: "failing" }))
    h.graph.fail(failing)
    const other = h.graph.add(mime({ subject: "other" }))
    await expect(
      h.sync.run({
        afterMessages: async () => {
          throw new Error("stopped")
        },
      }),
    ).rejects.toThrow("stopped")
    expect(await notRead(h)).toEqual([failing])
    const restarted = new IntakeSync({ db: h.database.db, settings: h.settings, files: h.files, graph: h.gateway })
    expect(await restarted.run()).toMatchObject({ status: "done", stored: 0, skipped: 2, notRead: 0 })
    expect(await rowsOf(h, failing)).toHaveLength(1)
    expect(await rowsOf(h, other)).toHaveLength(1)
    expect(await logOf(h, "failing")).toEqual([NOT_READ])
  })

  it("is processed once after a stop between its content and its ticket", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    h.graph.fail(failing, null)
    await h.sync.askAgain()
    const restarted = new IntakeSync({ db: h.database.db, settings: h.settings, files: h.files, graph: h.gateway })
    expect(await restarted.askAgain()).toEqual({ asked: 0, read: 0, gone: 0 })
    await restarted.run()
    await h.processor.run()
    await h.processor.run()
    expect(await h.database.db.select().from(intakeRecord)).toHaveLength(2)
    expect(await h.tickets()).toHaveLength(2)
  })

  it("is taken in once when two workers ask for it at the same time, also beside a sync round", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    h.graph.fail(failing, null)
    const second = new IntakeSync({ db: h.database.db, settings: h.settings, files: h.files, graph: h.gateway })
    const [one, two] = await Promise.all([h.sync.askAgain(), second.askAgain(), h.sync.run()])
    expect((one?.read ?? 0) + (two?.read ?? 0)).toBe(1)
    await h.round()
    expect(await rowsOf(h, failing)).toHaveLength(1)
    expect(await h.tickets()).toHaveLength(2)
  })

  it("is not asked for while another mailbox is configured, and resumes when its own is back", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    const own = h.graph.mailbox
    h.graph.allow("other-intake@example.com")
    await h.settings.update({ "graph.mailbox": "other-intake@example.com" }, SYSTEM)
    expect(await h.sync.askAgain()).toEqual({ asked: 0, read: 0, gone: 0 })
    await h.settings.update({ "graph.mailbox": own }, SYSTEM)
    h.graph.fail(failing, null)
    expect(await h.sync.askAgain()).toMatchObject({ read: 1 })
  })

  it("is not ended by an answer that arrives after another mailbox was configured", async () => {
    const h = await start()
    const failing = await failingMessage(h)
    h.graph.trash(failing)
    const hold = h.graph.hold(failing)
    const asked = h.sync.askAgain()
    await hold.reached
    h.graph.allow("other-intake@example.com")
    await h.settings.update({ "graph.mailbox": "other-intake@example.com" }, SYSTEM)
    hold.release()
    expect(await asked).toEqual({ asked: 1, read: 0, gone: 0 })
    expect(await notRead(h)).toEqual([failing])
  })

  it("gets its turn while its subject waits for the scanner, also beside others like it", async () => {
    const h = await start()
    await h.settings.update({ "scanner.address": await refusedAddress() }, SYSTEM)
    const recovers = h.graph.add(mime({ subject: "recovers" }))
    const fails = h.graph.add(mime({ subject: "fails" }))
    for (const id of [recovers, fails]) h.graph.fail(id)
    await h.round()
    expect(await notRead(h)).toHaveLength(2)
    h.graph.fail(recovers, null)
    for (let run = 0; run < 4; run++) {
      await h.retry.run(1)
      await h.sync.askAgain(1)
    }
    expect(await notRead(h)).toEqual([fails])
  })

  it("asks Graph for immutable IDs in every request", async () => {
    const h = await start()
    await failingMessage(h)
    await h.sync.askAgain()
    expect(h.graph.withoutImmutableIds).toEqual([])
  })

  it("leaves every waiting file its turn beside many messages not read yet", async () => {
    const h = await start()
    for (let i = 0; i <= MAX_ASKED_AGAIN_PER_RUN; i++) h.graph.fail(h.graph.add(mime({ subject: `many ${i}` })))
    await h.round()
    await h.settings.update({ "scanner.address": await refusedAddress() }, SYSTEM)
    const waiting = h.graph.add(mime({ subject: "waiting for the scanner" }))
    await h.sync.run()
    await h.settings.update({ "scanner.address": clamd.address }, SYSTEM)
    expect(await h.retry.run()).toMatchObject({ messages: 1, decided: 1 })
    expect((await h.messageOf(waiting)).subject).toBe("waiting for the scanner")
    expect(await h.sync.askAgain()).toMatchObject({ asked: MAX_ASKED_AGAIN_PER_RUN })
    expect(await h.sync.askAgain(1)).toMatchObject({ asked: 1 })
    const asked = (
      await h.database.db.select({ at: message.retryAt, flags: message.reviewFlags }).from(message)
    ).filter((row) => row.flags.includes("not_read"))
    expect(asked).toHaveLength(MAX_ASKED_AGAIN_PER_RUN + 1)
    expect(asked.every((row) => row.at !== null)).toBe(true)
  }, 120_000)
})
