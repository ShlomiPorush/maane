import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SYSTEM } from "@maane/server/audit"
import {
  auditLog,
  authUser,
  category,
  importReport,
  importRun,
  intakeRecord,
  message,
  organization,
  outbox,
  supportAddress,
  ticket,
  ticketCategory,
  ticketLink,
  ticketParticipant,
  timedAction,
  waitingPeriod,
  zendeskBrandMap,
  zendeskImport,
  zendeskTagMap,
} from "@maane/server/db/schema"
import { Imports } from "@maane/server/imports/service"
import type { JobQueue } from "@maane/server/jobs/queue"
import { Refusal } from "@maane/server/organizations/refusal"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { createTestDatabase, MIGRATIONS_DIR, testKey } from "@maane/server/testing/db"
import { MEGABYTE } from "@maane/shared"
import { Archive } from "@maane/zendesk"
import type { StandInZendesk } from "@maane/zendesk/testing/stand-in"
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { clamdScanner } from "../files/scanner.ts"
import { FileService } from "../files/service.ts"
import { FileStore } from "../files/store.ts"
import { MARKERS, type StandInClamd, startStandInClamd } from "../testing/clamd.ts"
import { AGENT, BRANDS, backupInto, HEBREW_BODY, HEBREW_SUBJECT, standInAccount } from "../testing/zendesk-archive.ts"
import { batches, failureOf, type ImportHooks, LINK_BATCH, ZendeskImport } from "./run.ts"

let clamd: StandInClamd
beforeAll(async () => {
  clamd = await startStandInClamd()
})
afterAll(async () => {
  await clamd.close()
})

interface Harness {
  database: Awaited<ReturnType<typeof createTestDatabase>>
  db: Awaited<ReturnType<typeof createTestDatabase>>["db"]
  settings: Settings
  files: FileService
  zendesk: StandInZendesk
  archive: string
  owner: string
  org: string
  vip: string
  /** A new run row and its job, as the page's Start makes them. */
  run(hooks?: ImportHooks): Promise<{ id: string; outcome: Awaited<ReturnType<ZendeskImport["run"]>> }>
  /** The job of an existing run again (a retry). */
  again(id: string, hooks?: ImportHooks): ReturnType<ZendeskImport["run"]>
  backup(): Promise<void>
  close(): Promise<void>
}

let harness: Harness | null = null
afterEach(async () => {
  await harness?.close()
  harness = null
})

async function start(): Promise<Harness> {
  const database = await createTestDatabase()
  const db = database.db
  const root = await mkdtemp(join(tmpdir(), "maane-import-"))
  const store = new FileStore(join(root, "files"))
  await store.prepare()
  const settings = new Settings(db, createSettingsCipher([{ version: 1, value: testKey() }]), {})
  await settings.update(
    { "scanner.address": clamd.address, "scanner.unavailablePolicy": "block", "files.maxBytes": 5 * MEGABYTE },
    SYSTEM,
  )
  const files = new FileService({ db, settings, scanner: clamdScanner, store })
  const zendesk = standInAccount()
  await zendesk.start()
  const archive = join(root, "archive")
  await backupInto(zendesk, archive)

  const owner = randomUUID()
  await db
    .insert(authUser)
    .values({ id: owner, name: "Owner", email: "owner@maane.invalid", username: "owner", role: "admin" })
  const [org] = await db.insert(organization).values({ name: "Example Store" }).returning({ id: organization.id })
  if (!org) throw new Error("no organization")
  await db
    .insert(supportAddress)
    .values({ organizationId: org.id, kind: "exact", value: "store@example.com", isDefault: true })
  const [vip] = await db.insert(category).values({ name: "VIP" }).returning({ id: category.id })
  if (!vip) throw new Error("no category")
  await db.insert(zendeskBrandMap).values({ brandId: String(BRANDS.mapped), organizationId: org.id })
  await db.insert(zendeskTagMap).values({ tag: "vip", categoryId: vip.id })
  await db.update(zendeskImport).set({ agentUserId: owner }).where(eq(zendeskImport.id, 1))

  const importer = (hooks?: ImportHooks) => new ZendeskImport({ db, files, archiveDir: archive, hooks })
  harness = {
    database,
    db,
    settings,
    files,
    zendesk,
    archive,
    owner,
    org: org.id,
    vip: vip.id,
    async run(hooks) {
      const [made] = await db.insert(importRun).values({ startedBy: owner }).returning({ id: importRun.id })
      if (!made) throw new Error("no run")
      return { id: made.id, outcome: await importer(hooks).run(made.id) }
    },
    again: (id, hooks) => importer(hooks).run(id),
    backup: () => backupInto(zendesk, archive),
    async close() {
      await zendesk.stop()
      await database.drop()
      await rm(root, { recursive: true, force: true })
    },
  }
  return harness
}

const runOf = async (h: Harness, id: string) => {
  const [row] = await h.db.select().from(importRun).where(eq(importRun.id, id))
  if (!row) throw new Error("no run")
  return row
}
const reportOf = async (h: Harness, id: string) =>
  (
    await h.db
      .select({ zendeskId: importReport.zendeskId, reason: importReport.reason, detail: importReport.detail })
      .from(importReport)
      .where(eq(importReport.runId, id))
      .orderBy(asc(importReport.id))
  ).map((row) => `${row.zendeskId}:${row.reason}:${row.detail ?? ""}`)
/** The import page's service, for a cancel; these tests queue no job. */
const NO_QUEUE: JobQueue = {
  send: async () => "",
  sendIn: async () => "",
  job: async () => null,
  pending: async () => null,
  stop: async () => {},
}
/** Cancels the open run, by its id as the page sends it. */
const cancelOf = (h: Harness) => async () => {
  const [open] = await h.db.select({ id: importRun.id }).from(importRun).where(eq(importRun.state, "running"))
  await new Imports(h.db, NO_QUEUE, h.archive).cancel(open?.id ?? "", { actor: SYSTEM, ipAddress: null })
}
/** Waits until a session of this database waits for a lock (a cancel waiting for a ticket's transaction). */
async function lockWaited(h: Harness): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    const { rows } = await h.db.execute(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    )
    if ((rows[0] as { n: number } | undefined)?.n) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("nothing waited for the ticket's transaction")
}
const ticketOf = async (h: Harness, number: number) => {
  const [row] = await h.db.select().from(ticket).where(eq(ticket.number, number))
  return row
}
const messagesOf = async (h: Harness, number: number) => {
  const t = await ticketOf(h, number)
  if (!t) return []
  return h.db.select().from(message).where(eq(message.ticketId, t.id)).orderBy(asc(message.receivedAt))
}
const participantsOf = async (h: Harness, number: number) => {
  const t = await ticketOf(h, number)
  if (!t) return []
  return (await h.db.select().from(ticketParticipant).where(eq(ticketParticipant.ticketId, t.id)))
    .map((row) => row.address)
    .sort()
}
const REPLACEMENT = String.fromCodePoint(0xfffd)

const nextNumber = async (h: Harness) => {
  const result = await h.db.execute(sql`select nextval('ticket_number_seq') as n`)
  return Number((result.rows[0] as { n: string }).n)
}

describe("the import from the Zendesk archive", () => {
  it("imports an invented archive, and a second run adds no duplicate", async () => {
    const h = await start()
    const first = await h.run()
    expect(first.outcome).toEqual({ state: "done", reason: null })

    // Tickets keep their Zendesk numbers; deleted, gone, and unmapped ones are not imported.
    const imported = await h.db.select().from(ticket).orderBy(asc(ticket.number))
    expect(imported.map((row) => [row.number, row.zendeskId, row.status])).toEqual([
      [1, 1, "open"],
      [2, 2, "pending"],
      [3, 3, "solved"],
      [7, 7, "new"],
    ])
    const one = imported[0]
    if (!one) throw new Error("no ticket 1")
    expect(one.organizationId).toBe(h.org)
    expect(one.subject).toBe(HEBREW_SUBJECT)
    expect(one.supportAddress).toBe("store@example.com")
    expect(one.zendesk).toMatchObject({
      brand: { id: String(BRANDS.mapped), name: "Example Store" },
      tags: ["vip", "billing"],
      fields: [
        { name: "Order number", value: "A-17" },
        { name: "Plan", value: "Gold plan" },
      ],
      followers: [{ name: AGENT.name, address: AGENT.email }],
    })
    // Requester and CCs are participants (they receive replies); the follower is not.
    expect(await participantsOf(h, 1)).toEqual(["user2@example.com", "user3@example.com"])
    // The tag mapping gives the category; an unmapped tag gives none.
    const categories = await h.db.select().from(ticketCategory).where(eq(ticketCategory.ticketId, one.id))
    expect(categories.map((row) => row.categoryId)).toEqual([h.vip])

    // Public end-user comments come in, agents' go out, private ones are notes, side conversations notes too.
    const messages = await messagesOf(h, 1)
    expect(messages.map((m) => [m.zendeskKey, m.direction, m.authorUserId])).toEqual([
      ["comment:11", "in", null],
      ["comment:12", "note", h.owner],
      ["comment:13", "out", h.owner],
      ["side:9001", "note", h.owner],
    ])
    const [question, note, , side] = messages
    expect(question?.textBody).toBe(HEBREW_BODY)
    expect(question?.htmlBody).toContain(HEBREW_BODY)
    expect(question?.fromAddress).toBe("user2@example.com")
    expect(question?.messageIdHeader).toBeNull()
    expect(question?.zendesk).toMatchObject({
      commentId: "11",
      email: {
        kind: "recorded",
        messageId: "question-1@mail.example.com",
        from: { address: "user2@example.com" },
        originalRecipients: ["store@example.com"],
      },
      files: [
        { id: "101", name: "invoice.pdf", status: "ok" },
        { id: "102", name: "a.png", inline: true, status: "ok" },
      ],
    })
    expect(note?.zendesk).toMatchObject({ author: { name: AGENT.name, role: "agent" }, email: { kind: "none" } })
    expect(side?.subject).toBe("Asking the supplier")
    expect(side?.textBody).toBe("Please check the order.")

    // A pending ticket gets an imported waiting period, which never sends a reminder.
    const two = await ticketOf(h, 2)
    const periods = await h.db
      .select()
      .from(waitingPeriod)
      .where(eq(waitingPeriod.ticketId, two?.id ?? ""))
    expect(periods.map((p) => [p.origin, p.endedAt])).toEqual([["import", null]])
    // Blocked text is kept out, flagged, and audited once; the comment stays.
    const blocked = (await messagesOf(h, 2)).find((m) => m.zendeskKey === "comment:22")
    expect(blocked?.textBody).toBeNull()
    expect(blocked?.reviewFlags).toContain("blocked_content")
    // A NUL character becomes U+FFFD and flags the message.
    const follow = (await messagesOf(h, 7))[0]
    expect(follow?.textBody).toBe(`Follow-up${String.fromCodePoint(0xfffd)} question`)
    expect(follow?.reviewFlags).toEqual(["invalid_characters"])
    // An author without an address keeps the name (its NUL replaced, and flagged) and gets no address.
    const walkIn = (await messagesOf(h, 3))[0]
    expect(walkIn?.fromAddress).toBeNull()
    expect(walkIn?.fromName).toBe(`Walk-in${REPLACEMENT} Customer`)
    expect(walkIn?.reviewFlags).toContain("invalid_characters")

    // Merged and follow-up tickets are links between the imported tickets.
    const links = await h.db.select().from(ticketLink)
    const numberOf = new Map(imported.map((row) => [row.id, row.number]))
    expect(
      links.map((link) => [numberOf.get(link.ticketId), numberOf.get(link.linkedTicketId), link.reason]).sort(),
    ).toEqual([
      [1, 3, "merged"],
      [7, 1, "follow_up"],
    ])

    // The report: every reason, and the counts and the archive's coverage.
    expect(await reportOf(h, first.id)).toEqual([
      "2:blocked_content:comment:22",
      "2:file_failed:big.zip",
      `3:file_failed:lost${REPLACEMENT}.txt`,
      "4:deleted_in_zendesk:",
      "5:deleted_in_zendesk:",
      "6:unmapped_brand:Example Outlet",
    ])
    const run = await runOf(h, first.id)
    expect(run).toMatchObject({ state: "done", total: 7, done: 7, highestNumber: 7, position: 7 })
    expect(run.coveredUntil).not.toBeNull()
    expect(run.counts).toMatchObject({ tickets: 4, notes: 1, sideConversations: 1, links: 2, skipped: 3 })

    // No side effects: no intake record, no outbox, no timed action (reminder, snooze, scheduled reply); one audit row
    // for the run, beside the block event.
    expect(await h.db.select().from(intakeRecord)).toHaveLength(0)
    expect(await h.db.select().from(outbox)).toHaveLength(0)
    expect(await h.db.select().from(timedAction)).toHaveLength(0)
    const audits = await h.db.select({ action: auditLog.action }).from(auditLog).orderBy(asc(auditLog.id))
    expect(audits.map((row) => row.action).filter((action) => action !== "setting.update")).toEqual([
      "message.content_blocked",
      "import.run",
    ])
    // The next Maane ticket continues right after the highest imported number.
    expect(await nextNumber(h)).toBe(8)

    // Again: the same rows, updated in place.
    const ids = (await h.db.select({ id: message.id }).from(message)).map((row) => row.id).sort()
    const second = await h.run()
    expect(second.outcome).toEqual({ state: "done", reason: null })
    expect((await h.db.select({ id: message.id }).from(message)).map((row) => row.id).sort()).toEqual(ids)
    expect(await h.db.select().from(ticket)).toHaveLength(4)
    expect(await h.db.select().from(ticketLink)).toHaveLength(2)
    expect(await h.db.select().from(waitingPeriod)).toHaveLength(1)
    // The block event is written once, not again for the same field.
    const blocks = await h.db.select().from(auditLog).where(eq(auditLog.action, "message.content_blocked"))
    expect(blocks).toHaveLength(1)
  })

  it("makes the copy match a newer archive: a comment made private, a redaction, changed CCs, a deleted ticket", async () => {
    const h = await start()
    await h.run()
    const before = await messagesOf(h, 1)
    h.zendesk.change(1, (t) => {
      const [question, , answer] = t.comments
      if (question) {
        question.body = "[redacted]"
        question.extra = { ...question.extra, plain_body: "[redacted]", html_body: "<p>[redacted]</p>" }
      }
      if (answer) answer.public = false
      t.record = { ...t.record, email_cc_ids: [] }
    })
    h.zendesk.setStatus(2, "deleted")
    await h.backup()
    const second = await h.run()
    expect(second.outcome).toEqual({ state: "done", reason: null })
    const after = await messagesOf(h, 1)
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id))
    expect(after.find((m) => m.zendeskKey === "comment:11")?.textBody).toBe("[redacted]")
    expect(after.find((m) => m.zendeskKey === "comment:11")?.htmlBody).not.toContain(HEBREW_BODY)
    expect(after.find((m) => m.zendeskKey === "comment:13")?.direction).toBe("note")
    expect(await participantsOf(h, 1)).toEqual(["user2@example.com"])
    // A ticket deleted in Zendesk is reported; what was imported stays (no hiding or erasing logic).
    expect(await reportOf(h, second.id)).toContain("2:deleted_in_zendesk:")
    expect(await ticketOf(h, 2)).toBeDefined()
  })

  it("goes on after a crash from the last ticket it committed", async () => {
    const h = await start()
    const crash: ImportHooks = {
      afterTicket: async (id) => {
        if (id === 2) throw new Error("the worker stopped")
      },
    }
    const [made] = await h.db.insert(importRun).values({ startedBy: h.owner }).returning({ id: importRun.id })
    const id = made?.id ?? ""
    await expect(h.again(id, crash)).rejects.toThrow("the worker stopped")
    expect(await runOf(h, id)).toMatchObject({ state: "running", position: 2, done: 2 })
    expect(await h.db.select().from(ticket)).toHaveLength(2)
    // A switch to live waits for the open run: refused.
    await expect(h.settings.update({ "intake.mode": "live" }, SYSTEM)).rejects.toMatchObject({
      code: "import_running",
    })
    expect(await h.again(id)).toEqual({ state: "done", reason: null })
    expect(await runOf(h, id)).toMatchObject({ state: "done", position: 7, done: 7 })
    expect(await h.db.select().from(ticket)).toHaveLength(4)
    // Each ticket's report rows were written once, with its transaction.
    expect((await reportOf(h, id)).filter((row) => row.startsWith("2:"))).toHaveLength(2)
  })

  it("cancelled mid-ticket, finishes that ticket and writes nothing after the cancel returned", async () => {
    const h = await start()
    const [made] = await h.db.insert(importRun).values({ startedBy: h.owner }).returning({ id: importRun.id })
    const id = made?.id ?? ""
    const snapshot = async () => ({
      run: await runOf(h, id),
      tickets: (await h.db.select({ id: ticket.id }).from(ticket)).length,
      messages: (await h.db.select({ id: message.id }).from(message)).length,
      report: await reportOf(h, id),
      audit: (await h.db.select({ action: auditLog.action }).from(auditLog).orderBy(asc(auditLog.id))).map(
        (row) => row.action,
      ),
    })
    const pending: { cancel?: Promise<Awaited<ReturnType<typeof snapshot>>> } = {}
    const outcome = await h.again(id, {
      // Inside ticket 2's transaction: the cancel waits for it, then the handler goes on to ticket 3.
      inTicket: async (zendeskId) => {
        if (zendeskId !== 2) return
        pending.cancel = cancelOf(h)().then(snapshot)
        await lockWaited(h)
      },
    })
    expect(outcome).toEqual({ state: "stopped", reason: "cancelled" })
    const atCancel = await pending.cancel
    expect(atCancel?.run).toMatchObject({ state: "stopped", reason: "cancelled", position: 2, done: 2 })
    expect(atCancel?.tickets).toBe(2)
    expect(await snapshot()).toEqual(atCancel)
    // One audit row for the run: its cancel, never an end the worker wrote.
    expect(atCancel?.audit.filter((action) => action.startsWith("import."))).toEqual(["import.cancel"])
    // The next start is a full pass.
    const next = await h.run()
    expect(next.outcome).toEqual({ state: "done", reason: null })
    expect(await runOf(h, next.id)).toMatchObject({ done: 7, position: 7 })
  })

  it("writes nothing for a run cancelled before its first write, new or going on after a crash", async () => {
    const h = await start()
    const cancel = cancelOf(h)
    const fresh = await h.run({ afterCheck: cancel })
    expect(fresh.outcome).toEqual({ state: "stopped", reason: "cancelled" })
    expect(await runOf(h, fresh.id)).toMatchObject({
      state: "stopped",
      reason: "cancelled",
      archiveRuns: null,
      done: 0,
    })
    expect((await h.db.select().from(zendeskImport))[0]?.origin).toBeNull()
    expect(await h.db.select().from(ticket)).toEqual([])

    const [made] = await h.db.insert(importRun).values({ startedBy: h.owner }).returning({ id: importRun.id })
    const id = made?.id ?? ""
    const crash: ImportHooks = {
      afterTicket: async (zendeskId) => {
        if (zendeskId === 2) throw new Error("the worker stopped")
      },
    }
    await expect(h.again(id, crash)).rejects.toThrow("the worker stopped")
    expect(await h.again(id, { afterCheck: cancel })).toEqual({ state: "stopped", reason: "cancelled" })
    expect(await runOf(h, id)).toMatchObject({ state: "stopped", reason: "cancelled", failure: null, position: 2 })
    // A job left for it does nothing.
    expect(await h.again(id)).toEqual({ skipped: true })
    expect(await h.db.select().from(ticket)).toHaveLength(2)
  })

  it("counts the links once when it goes on after a crash between the links and the end", async () => {
    const h = await start()
    const [made] = await h.db.insert(importRun).values({ startedBy: h.owner }).returning({ id: importRun.id })
    const id = made?.id ?? ""
    const crash: ImportHooks = {
      afterLinks: async () => {
        throw new Error("the worker stopped")
      },
    }
    await expect(h.again(id, crash)).rejects.toThrow("the worker stopped")
    expect(await runOf(h, id)).toMatchObject({ state: "running", position: 7, counts: { links: 2 } })
    expect(await h.again(id)).toEqual({ state: "done", reason: null })
    expect(await h.db.select().from(ticketLink)).toHaveLength(2)
    expect((await runOf(h, id)).counts).toMatchObject({ links: 2 })
  })

  it("stops when a backup runs meanwhile, and the next start is a full pass that applies a redaction", async () => {
    const h = await start()
    const meanwhile: ImportHooks = {
      afterTicket: async (id) => {
        if (id !== 1) return
        h.zendesk.change(1, (t) => {
          const question = t.comments[0]
          if (question) question.extra = { ...question.extra, plain_body: "[redacted]", html_body: "<p>[redacted]</p>" }
        })
        await h.backup()
      },
    }
    const stopped = await h.run(meanwhile)
    expect(stopped.outcome).toEqual({ state: "stopped", reason: "archive_changed" })
    expect(await runOf(h, stopped.id)).toMatchObject({ position: 1 })
    // Ticket 1 was imported from the older state; the numbers already go on after it.
    expect((await messagesOf(h, 1))[0]?.textBody).toBe(HEBREW_BODY)
    expect(await nextNumber(h)).toBe(2)
    // A stopped run is not continued: the next start is a new run over every ticket.
    expect(await h.again(stopped.id)).toEqual({ skipped: true })
    const full = await h.run()
    expect(full.outcome).toEqual({ state: "done", reason: null })
    expect((await messagesOf(h, 1))[0]?.textBody).toBe("[redacted]")
    expect(await runOf(h, full.id)).toMatchObject({ done: 7, position: 7 })
  })

  it("refuses after the first switch to live, and switching to live is refused while a run is open", async () => {
    const h = await start()
    const [open] = await h.db.insert(importRun).values({ startedBy: h.owner }).returning({ id: importRun.id })
    await expect(h.settings.update({ "intake.mode": "live" }, SYSTEM)).rejects.toBeInstanceOf(Refusal)
    expect(await h.again(open?.id ?? "")).toEqual({ state: "done", reason: null })
    await h.settings.update({ "intake.mode": "live" }, SYSTEM)
    // Back to listening keeps the window closed: going live is recorded for good.
    await h.settings.update({ "intake.mode": "listening" }, SYSTEM)
    const [row] = await h.db.select().from(zendeskImport)
    expect(row?.wentLiveAt).not.toBeNull()
    const refused = await h.run()
    expect(refused.outcome).toEqual({ state: "refused", reason: "went_live" })
  })

  it("refuses during a backup, for an incomplete archive, from another origin, and without a chosen user", async () => {
    const h = await start()
    const lock = join(h.archive, ".lock")
    await writeFile(lock, "{}\n")
    expect((await h.run()).outcome).toEqual({ state: "refused", reason: "backup_running" })
    await unlink(lock)

    const page = join(h.archive, "raw/incremental/users/000001.json")
    const archive = new Archive(h.archive)
    const original = await archive.readJson<unknown>("raw/incremental/users/000001.json")
    await writeFile(page, '{"users":[],"end_of_stream":false}')
    const incomplete = await h.run()
    expect(incomplete.outcome).toEqual({ state: "refused", reason: "archive_incomplete" })
    expect((await runOf(h, incomplete.id)).problems).toContain(
      "raw/incremental/users/000001.json changed after it was written",
    )
    await writeFile(page, JSON.stringify(original))
    await h.backup()

    await h.db.update(zendeskImport).set({ origin: "https://other.example.com" })
    expect((await h.run()).outcome).toEqual({ state: "refused", reason: "other_origin" })
    await h.db.update(zendeskImport).set({ origin: null, agentUserId: null })
    expect((await h.run()).outcome).toEqual({ state: "refused", reason: "no_agent" })
    // Nothing was written by a refused run.
    expect(await h.db.select().from(ticket)).toHaveLength(0)
    expect(await h.db.select().from(message).where(isNotNull(message.zendeskKey))).toHaveLength(0)
  })

  it("catches a backup that starts and fails during the check before the first write", async () => {
    const h = await start()
    const archive = new Archive(h.archive)
    // A backup that starts (its run count moves on) and fails (its lock goes again) while the check reads.
    const backupStartsAndFails = async () => {
      const state = await archive.state()
      state.runs += 1
      await archive.saveState(state)
    }
    const always = await h.run({ afterCheck: backupStartsAndFails })
    expect(always.outcome).toEqual({ state: "refused", reason: "archive_changed" })
    expect(await h.db.select().from(ticket)).toHaveLength(0)
    // Once: the run checks the new state again and imports it.
    let once = false
    const result = await h.run({
      afterCheck: async () => {
        if (once) return
        once = true
        await backupStartsAndFails()
      },
    })
    expect(result.outcome).toEqual({ state: "done", reason: null })
    expect((await runOf(h, result.id)).archiveRuns).toBe((await archive.state()).runs)
  })

  it("reports an unmapped brand until it is mapped, then imports its ticket", async () => {
    const h = await start()
    const first = await h.run()
    expect(await reportOf(h, first.id)).toContain("6:unmapped_brand:Example Outlet")
    await h.db.insert(zendeskBrandMap).values({ brandId: String(BRANDS.other), organizationId: h.org })
    const second = await h.run()
    expect(await reportOf(h, second.id)).not.toContain("6:unmapped_brand:Example Outlet")
    expect((await ticketOf(h, 6))?.organizationId).toBe(h.org)
  })

  it("keeps a ticket's own text out when the scanner blocks it, with one block event", async () => {
    const h = await start()
    h.zendesk.change(7, (t) => {
      t.record = { ...t.record, subject: `Help ${MARKERS.infected}`, tags: ["vip"] }
    })
    await h.backup()
    const first = await h.run()
    expect(await reportOf(h, first.id)).toContain("7:blocked_content:ticket")
    const seven = await ticketOf(h, 7)
    expect(seven?.subject).toBeNull()
    expect(seven?.zendesk).toMatchObject({ blocked: true, tags: [], fields: [] })
    // Its participants keep their addresses, not their names.
    const people = await h.db
      .select()
      .from(ticketParticipant)
      .where(eq(ticketParticipant.ticketId, seven?.id ?? ""))
    expect(people.map((person) => [person.address, person.name])).toEqual([["user2@example.com", null]])
    await h.run()
    const events = await h.db.select().from(auditLog).where(eq(auditLog.action, "ticket.content_blocked"))
    expect(events).toHaveLength(1)
  })

  it("stops at a ticket the database refuses, says which and why, and goes on from it once the cause is fixed", async () => {
    const h = await start()
    await h.db.execute(sql`alter table ticket add constraint test_refuses_three check (zendesk_id is distinct from 3)`)
    const [made] = await h.db.insert(importRun).values({ startedBy: h.owner }).returning({ id: importRun.id })
    const id = made?.id ?? ""
    const failures = async () => (await reportOf(h, id)).filter((row) => row.includes(":ticket_failed:"))
    await expect(h.again(id)).rejects.toThrow()
    // The run stays open where it stopped; the report names the ticket and the kind of error, never its text.
    expect(await runOf(h, id)).toMatchObject({ state: "running", reason: "failed", position: 2, done: 2 })
    expect(await failures()).toEqual(["3:ticket_failed:rule:test_refuses_three"])
    // Tried again before the cause is fixed: the newest error only.
    await expect(h.again(id)).rejects.toThrow()
    expect(await failures()).toEqual(["3:ticket_failed:rule:test_refuses_three"])
    await h.db.execute(sql`alter table ticket drop constraint test_refuses_three`)
    expect(await h.again(id)).toEqual({ state: "done", reason: null })
    expect(await runOf(h, id)).toMatchObject({ state: "done", reason: null, done: 7, position: 7 })
    expect(await failures()).toEqual([])
    expect(await h.db.select().from(ticket)).toHaveLength(4)
  })

  it("names the stage and the kind of an error no ticket caused, and clears them when the run goes on", async () => {
    const h = await start()
    const [made] = await h.db.insert(importRun).values({ startedBy: h.owner }).returning({ id: importRun.id })
    const id = made?.id ?? ""
    const failures = async () => (await reportOf(h, id)).filter((row) => row.includes(":ticket_failed:"))
    // A users' page that no longer parses after the check: an error of the archive while reading it.
    const page = join(h.archive, "raw/incremental/users/000001.json")
    const original = await readFile(page, "utf8")
    await expect(h.again(id, { afterCheck: () => writeFile(page, "{") })).rejects.toThrow(SyntaxError)
    expect(await runOf(h, id)).toMatchObject({
      state: "running",
      reason: "failed",
      failure: "archive:archive",
      done: 0,
    })
    expect(await failures()).toEqual([])
    await writeFile(page, original)
    // The database refuses every link: an error of the links stage, with the rule it named.
    await h.db.execute(sql`alter table ticket_link add constraint test_refuses_links check (ticket_id is null)`)
    await expect(h.again(id)).rejects.toThrow()
    expect(await runOf(h, id)).toMatchObject({
      state: "running",
      reason: "failed",
      failure: "links:rule:test_refuses_links",
      done: 7,
    })
    expect(await failures()).toEqual([])
    await h.db.execute(sql`alter table ticket_link drop constraint test_refuses_links`)
    expect(await h.again(id)).toEqual({ state: "done", reason: null })
    expect(await runOf(h, id)).toMatchObject({ state: "done", reason: null, failure: null })
  })

  it("reports a failed file by its ID when the scanner blocked its name", async () => {
    const h = await start()
    h.zendesk.change(2, (t) => {
      const big = t.comments[0]?.files[0]
      if (big) big.name = `big ${MARKERS.infected}.zip`
    })
    await h.backup()
    const run = await h.run()
    const report = await reportOf(h, run.id)
    expect(report).toContain("2:file_failed:201")
    expect(report).toContain("2:blocked_content:comment:21")
    expect(report.join("\n")).not.toContain(MARKERS.infected)
    const rows = await h.db.select({ detail: importReport.detail }).from(importReport)
    expect(rows.some((row) => row.detail?.includes("big"))).toBe(false)
  })

  it("links more imported tickets than one statement has parameters for", async () => {
    const h = await start()
    // 33,000 imported tickets, each a follow-up of the one before: more than PostgreSQL's 65,535 parameters if each
    // ticket's ID were a parameter twice, or each link three. The reference code is distinct per ticket, of the form.
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    const digit = (power: number) => sql.raw(`substr('${alphabet}', (n / ${31 ** power}) % 31 + 1, 1)`)
    await h.db.execute(sql`
      insert into ticket (number, zendesk_id, reference_code, organization_id, support_address, status, zendesk)
      select n, n, 'AAAA-' || ${digit(3)} || ${digit(2)} || ${digit(1)} || ${digit(0)}, ${h.org}, 'store@example.com',
        'open', jsonb_build_object('links', jsonb_build_array(jsonb_build_object('zendeskId', n - 1, 'reason', 'follow_up')))
      from generate_series(100001, 133000) as n`)
    const run = await h.run()
    expect(run.outcome).toEqual({ state: "done", reason: null })
    // The archive's two links and 32,999 follow-ups (the first one's original is not imported).
    const [links] = (await h.db.execute(sql`select count(*)::int as n from ticket_link`)).rows as { n: number }[]
    expect(links?.n).toBe(2 + 32_999)
    expect((await runOf(h, run.id)).counts).toMatchObject({ links: 2 + 32_999 })
    expect(await nextNumber(h)).toBe(133_001)
  })

  it("closes the window in its migration for a database that went live and back to listening", async () => {
    const database = await createTestDatabase()
    try {
      const db = database.db
      const migration = await readFile(join(MIGRATIONS_DIR, "0025_import_row.sql"), "utf8")
      const replayed = async () => {
        await db.delete(zendeskImport)
        await db.execute(sql.raw(migration))
        const [row] = await db.select().from(zendeskImport)
        if (!row) throw new Error("no row")
        return row.wentLiveAt !== null
      }
      const [org] = await db.insert(organization).values({ name: "Example Store" }).returning({ id: organization.id })
      const at = { organizationId: org?.id ?? "", supportAddress: "store@example.com" }
      // Never used: open. Imported rows alone (an imported ticket and comment) leave it open too.
      expect(await replayed()).toBe(false)
      const [imported] = await db
        .insert(ticket)
        .values({ ...at, number: 900, zendeskId: 900, zendesk: {}, referenceCode: "AAAA-BBBB" })
        .returning({ id: ticket.id })
      const [comment] = await db
        .insert(message)
        .values({
          direction: "in",
          receivedAt: new Date(),
          ticketId: imported?.id,
          state: "processed",
          content: "parsed",
          zendeskKey: "comment:1",
          zendesk: sql`'{}'::jsonb`,
        })
        .returning({ id: message.id })
      const messageId = comment?.id ?? ""
      expect(await replayed()).toBe(false)
      // A message intake processed in live mode: closed; one it processed while listening: open.
      await db.insert(intakeRecord).values({ messageId, mode: "live", outcome: "joined" })
      expect(await replayed()).toBe(true)
      await db.update(intakeRecord).set({ mode: "listening" })
      expect(await replayed()).toBe(false)
      await db.delete(intakeRecord)
      // An outbox row: closed.
      await db.insert(outbox).values({
        messageId,
        mime: Buffer.from("x"),
        messageIdHeader: "reply-1@example.com",
        fromAddress: "store@example.com",
      })
      expect(await replayed()).toBe(true)
      await db.delete(outbox)
      // A ticket Maane opened: closed.
      const [opened] = await db
        .insert(ticket)
        .values({ ...at, number: 1, referenceCode: "CCCC-DDDD" })
        .returning({ id: ticket.id })
      expect(await replayed()).toBe(true)
      await db.delete(ticket).where(eq(ticket.id, opened?.id ?? ""))
      expect(await replayed()).toBe(false)
      // Live intake now: closed.
      await db
        .insert(supportAddress)
        .values({ organizationId: at.organizationId, kind: "exact", value: at.supportAddress, isDefault: true })
      const settings = new Settings(db, createSettingsCipher([{ version: 1, value: testKey() }]), {})
      await settings.update({ "intake.mode": "live" }, SYSTEM)
      expect(await replayed()).toBe(true)
      // Switched to live and back to listening with no mail meanwhile: the audited switch alone closes it.
      await settings.update({ "intake.mode": "listening" }, SYSTEM)
      expect(await db.select().from(ticket).where(isNull(ticket.zendeskId))).toEqual([])
      expect(await db.select().from(outbox)).toEqual([])
      expect(await db.select().from(intakeRecord)).toEqual([])
      expect(await replayed()).toBe(true)
    } finally {
      await database.drop()
    }
  })

  it("leaves a ticket Maane already numbered and reports it", async () => {
    const h = await start()
    await h.db.insert(ticket).values({
      number: 3,
      referenceCode: "ABCD-EFGH",
      organizationId: h.org,
      supportAddress: "store@example.com",
      subject: "Opened by Maane",
    })
    const run = await h.run()
    expect(await reportOf(h, run.id)).toContain("3:number_taken:")
    expect((await ticketOf(h, 3))?.zendeskId).toBeNull()
    const rows = await h.db
      .select()
      .from(ticket)
      .where(inArray(ticket.number, [1, 2, 3, 7]))
    expect(rows.filter((row) => row.zendeskId !== null)).toHaveLength(3)
    expect(
      await h.db
        .select()
        .from(ticketLink)
        .where(and(isNotNull(ticketLink.reason), eq(ticketLink.reason, "merged"))),
    ).toHaveLength(0)
  })
})

describe("the import's batches", () => {
  it("splits a list in order into batches of at most the size", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(batches([], 2)).toEqual([])
    expect(LINK_BATCH * 3).toBeLessThan(65_535)
  })

  it("names the kind of error that stopped a ticket, never its text", () => {
    const database = (code: string, constraint?: string) =>
      Object.assign(new Error("Failed query"), {
        cause: Object.assign(new Error("value (secret)"), { code, constraint }),
      })
    expect(failureOf(database("23505", "message_zendesk_key_unique"))).toBe("duplicate:message_zendesk_key_unique")
    expect(failureOf(database("23503", "ticket_organization_id_organization_id_fk"))).toBe(
      "reference:ticket_organization_id_organization_id_fk",
    )
    expect(failureOf(database("23514", "test_rule"))).toBe("rule:test_rule")
    expect(failureOf(database("22001"))).toBe("value")
    expect(failureOf(database("57014"))).toBe("other")
    expect(failureOf(database("23514", "Not A Name"))).toBe("rule")
    expect(failureOf(Object.assign(new Error("no file"), { code: "ENOENT", path: "/archive/raw/x.json" }))).toBe(
      "archive",
    )
    expect(failureOf(new SyntaxError("Unexpected token"))).toBe("archive")
    // A network error is not the archive's.
    expect(failureOf(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe("other")
    expect(failureOf(new Error("something else"))).toBe("other")
  })
})
