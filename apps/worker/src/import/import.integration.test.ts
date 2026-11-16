import { randomUUID } from "node:crypto"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
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
import { Refusal } from "@maane/server/organizations/refusal"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { createTestDatabase, testKey } from "@maane/server/testing/db"
import { MEGABYTE } from "@maane/shared"
import { Archive } from "@maane/zendesk"
import type { StandInZendesk } from "@maane/zendesk/testing/stand-in"
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { clamdScanner } from "../files/scanner.ts"
import { FileService } from "../files/service.ts"
import { FileStore } from "../files/store.ts"
import { type StandInClamd, startStandInClamd } from "../testing/clamd.ts"
import { AGENT, BRANDS, backupInto, HEBREW_BODY, HEBREW_SUBJECT, standInAccount } from "../testing/zendesk-archive.ts"
import { type ImportHooks, ZendeskImport } from "./run.ts"

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
      "3:file_failed:lost.txt",
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
