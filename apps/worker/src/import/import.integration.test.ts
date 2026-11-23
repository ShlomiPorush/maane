import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises"
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
  intakeSource,
  message,
  messagePart,
  organization,
  outbox,
  storedFile,
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
import { createTestDatabase, testKey } from "@maane/server/testing/db"
import { MEGABYTE } from "@maane/shared"
import { Archive } from "@maane/zendesk"
import type { StandInFile, StandInZendesk } from "@maane/zendesk/testing/stand-in"
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { clamdScanner } from "../files/scanner.ts"
import { FileService, sha256Of } from "../files/service.ts"
import { FileStore } from "../files/store.ts"
import { IntakeProcessor } from "../intake/process.ts"
import { MARKERS, type StandInClamd, startStandInClamd } from "../testing/clamd.ts"
import { AGENT, BRANDS, backupInto, HEBREW_BODY, HEBREW_SUBJECT, standInAccount } from "../testing/zendesk-archive.ts"
import {
  ArchivedFileError,
  batches,
  failureOf,
  type ImportHooks,
  LINK_BATCH,
  ScannerWaitingError,
  ZendeskImport,
} from "./run.ts"

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
  /** A backup run again; files up to `maxFileBytes` (1 KiB by default). */
  backup(maxFileBytes?: number): Promise<void>
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
    backup: (maxFileBytes) => backupInto(zendesk, archive, maxFileBytes),
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
    // Finish import waits for the open run: refused.
    await expect(
      new Imports(h.db, NO_QUEUE, h.archive).finish({ actor: SYSTEM, ipAddress: null }),
    ).rejects.toMatchObject({ code: "import_running" })
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

  it("Finish import: refused while a run is open, final, audited, and imports refused after it", async () => {
    const h = await start()
    const imports = new Imports(h.db, NO_QUEUE, h.archive)
    const acting = { actor: SYSTEM, ipAddress: null }
    const [open] = await h.db.insert(importRun).values({ startedBy: h.owner }).returning({ id: importRun.id })
    await expect(imports.finish(acting)).rejects.toBeInstanceOf(Refusal)
    expect((await h.db.select().from(zendeskImport))[0]?.finishedAt).toBeNull()
    expect(await h.again(open?.id ?? "")).toEqual({ state: "done", reason: null })
    await imports.finish(acting)
    const [row] = await h.db.select().from(zendeskImport)
    expect(row?.finishedAt).not.toBeNull()
    // Final: pressing it again changes nothing and writes no second audit row.
    await imports.finish(acting)
    expect((await h.db.select().from(zendeskImport))[0]?.finishedAt).toEqual(row?.finishedAt)
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.action, "import.finish"))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ entityType: "zendesk_import", entityId: "1", actorLabel: SYSTEM.label })
    expect((await imports.view()).window).toEqual({ open: false, finishedAt: row?.finishedAt?.toISOString() })
    // Imports are refused after it: a run, a start, and the mappings.
    const refused = await h.run()
    expect(refused.outcome).toEqual({ state: "refused", reason: "finished" })
    await expect(imports.start(h.owner)).rejects.toMatchObject({ code: "import_closed" })
    await expect(imports.saveMapping({ brands: {}, tags: {}, agentUserId: h.owner }, acting)).rejects.toMatchObject({
      code: "import_closed",
    })
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

const DONE = { state: "done", reason: null }
const fileOf = (id: number, name: string, content: Buffer): StandInFile => ({ id, name, content, serve: "redirect" })
const partsOf = (h: Harness) => h.db.select().from(messagePart).orderBy(asc(messagePart.zendeskAttachmentId))
/** How many of these contents the stand-in clamd was given to scan since `from`. */
const scansOf = (contents: Buffer[], from: number) =>
  clamd.scanned.slice(from).filter((scanned) => contents.some((content) => content.equals(scanned))).length
/** A new run row, as the page's Start makes it, without running its job. */
const newRun = async (h: Harness) => {
  const [made] = await h.db.insert(importRun).values({ startedBy: h.owner }).returning({ id: importRun.id })
  return made?.id ?? ""
}
/**
 * Runs a job while the stand-in clamd refuses streams longer than `limit` (as clamd past its StreamMaxLength), after a
 * self-test it passed: a file that long gets no verdict and waits.
 */
async function withShortStreams<T>(h: Harness, limit: number, work: () => Promise<T>): Promise<T> {
  expect(await h.files.trustedScanner()).toBe(clamd.address)
  clamd.options.streamMaxLength = limit
  try {
    return await work()
  } finally {
    delete clamd.options.streamMaxLength
  }
}

describe("the import's files", () => {
  it("stores files through the scanner with intake's statuses and block events, reports refused ones, scans no stored file again, and takes a file once the limit allows it", async () => {
    const h = await start()
    await h.settings.update({ "files.maxBytes": MEGABYTE }, SYSTEM)
    const infected = Buffer.from(`report ${MARKERS.infected}`)
    const program = randomBytes(40)
    const huge = Buffer.alloc(MEGABYTE + 1, 0x61)
    h.zendesk.addComment(1, {
      id: 14,
      public: true,
      body: "Three files",
      files: [fileOf(141, "report.txt", infected), fileOf(142, "setup.exe", program), fileOf(143, "huge.log", huge)],
      extra: { author_id: 2 },
    })
    await h.backup(2 * MEGABYTE)
    const first = await h.run()
    expect(first.outcome).toEqual(DONE)

    // Each file of the archive is a part of its own comment, with intake's statuses.
    const keyOf = new Map((await messagesOf(h, 1)).map((m) => [m.id, m.zendeskKey]))
    const parts = (await partsOf(h)).filter((p) => keyOf.has(p.messageId))
    expect(
      parts.map((p) => [
        p.zendeskAttachmentId,
        keyOf.get(p.messageId),
        p.index,
        p.status,
        p.storedSha256 !== null,
        p.fileName,
      ]),
    ).toEqual([
      ["101", "comment:11", 0, "clean", true, "invoice.pdf"],
      ["102", "comment:11", 1, "clean", true, "a.png"],
      ["141", "comment:14", 0, "infected", false, "report.txt"],
      ["142", "comment:14", 1, "blocked_type", false, "setup.exe"],
      ["143", "comment:14", 2, "too_large", false, "huge.log"],
      ["401", "side:9001", 0, "clean", true, "side.txt"],
    ])
    const part = (id: string) => parts.find((p) => p.zendeskAttachmentId === id)
    expect(part("102")?.kind).toBe("inline")
    expect(part("141")?.signature).toBe("Eicar-Test-Signature")
    expect(part("142")?.blockedBy).toBe("exe")
    expect([part("143")?.size, part("143")?.sha256]).toEqual([MEGABYTE + 1, sha256Of(huge)])
    // Stored content is the archive's file; refused content never reaches the store.
    for (const row of parts.filter((p) => p.storedSha256 !== null)) {
      const source = h.zendesk.allFiles().find((f) => String(f.id) === row.zendeskAttachmentId)
      expect(await readFile(h.files.storedPath(row.storedSha256 as string))).toEqual(source?.content)
    }
    const stored = (await h.db.select({ sha256: storedFile.sha256 }).from(storedFile)).map((row) => row.sha256)
    for (const refused of [infected, program, huge]) expect(stored).not.toContain(sha256Of(refused))
    // A part over the limit flags its message, as intake's do.
    expect((await messagesOf(h, 1)).find((m) => m.zendeskKey === "comment:14")?.reviewFlags).toEqual(["part_too_large"])
    // The report lists the infected and the blocked file by name; one block event each.
    expect((await reportOf(h, first.id)).filter((row) => row.startsWith("1:"))).toEqual([
      "1:file_infected:report.txt",
      "1:file_blocked:setup.exe",
    ])
    const events = async () =>
      (await h.db.select({ details: auditLog.details }).from(auditLog).where(eq(auditLog.action, "file.blocked")))
        .map((row) => row.details as { reason: string; fileName: string; part: string })
        .map((details) => [details.reason, details.fileName, details.part])
        .sort()
    expect(await events()).toEqual([
      ["blocked_type", "setup.exe", part("142")?.id],
      ["infected", "report.txt", part("141")?.id],
    ])

    // Again: the same parts and stored rows, no stored file scanned or stored again, no second block event, the same
    // report. A file whose content was not stored is decided again: the infected one goes to the scanner again (the
    // blocked type is refused by its type, before the scanner), and the one still over the limit is not read.
    const storedBefore = await h.db.select().from(storedFile).orderBy(asc(storedFile.sha256))
    const kept = h.zendesk.allFiles().filter((f) => ![141, 142, 143].includes(Number(f.id)))
    const from = clamd.scanned.length
    const second = await h.run()
    expect(second.outcome).toEqual(DONE)
    expect((await partsOf(h)).filter((p) => keyOf.has(p.messageId))).toEqual(
      parts.map((p) => ({ ...p, updatedAt: expect.any(Date) })),
    )
    expect(await h.db.select().from(storedFile).orderBy(asc(storedFile.sha256))).toEqual(storedBefore)
    expect(scansOf([...kept.map((f) => f.content), program, huge], from)).toBe(0)
    expect(scansOf([infected], from)).toBe(1)
    expect(await events()).toHaveLength(2)
    expect((await reportOf(h, second.id)).filter((row) => row.startsWith("1:"))).toEqual([
      "1:file_infected:report.txt",
      "1:file_blocked:setup.exe",
    ])

    // Once the admin raises the limit, the file refused as too large is scanned and stored by the next run.
    await h.settings.update({ "files.maxBytes": 2 * MEGABYTE }, SYSTEM)
    const third = await h.run()
    expect(third.outcome).toEqual(DONE)
    const [grown] = await h.db.select().from(messagePart).where(eq(messagePart.zendeskAttachmentId, "143"))
    expect([grown?.id, grown?.status, grown?.storedSha256]).toEqual([part("143")?.id, "clean", sha256Of(huge)])
    expect(await readFile(h.files.storedPath(sha256Of(huge)))).toEqual(huge)
    expect((await messagesOf(h, 1)).find((m) => m.zendeskKey === "comment:14")?.reviewFlags).toEqual([])
    expect(await events()).toHaveLength(2)
  })

  it("imports a side conversation file by its string ID, and reports a file with no ID it can use", async () => {
    const h = await start()
    // Before: ticket 1's side conversation carries one file.
    const before = await h.run()
    const filesBefore = ((await runOf(h, before.id)).counts as { files: number }).files
    // Zendesk's side conversation attachments have string IDs (its Side Conversation Attachments reference).
    const photo: StandInFile = {
      id: "01M1BJQJ58GFNNX614V04CHXTS",
      name: "photo.txt",
      content: randomBytes(30),
      serve: "redirect",
    }
    const url = (id: string) => `${h.zendesk.apiOrigin}/attachments/token/t${id}/?name=file`
    h.zendesk.change(1, (t) => {
      t.sides = [
        {
          id: "sc-2",
          subject: "Asking the courier",
          events: [
            {
              id: 9101,
              type: "create",
              message: {
                subject: "Asking the courier",
                body: "Two files",
                attachments: [
                  { id: photo.id, name: photo.name, content_url: url(String(photo.id)), size: photo.content.length },
                  { name: "unnamed.txt", content_url: url("none"), size: 4 },
                ],
              },
            },
          ],
          files: [photo],
        },
      ]
    })
    await h.backup()
    const run = await h.run()
    expect(run.outcome).toEqual(DONE)
    const note = (await messagesOf(h, 1)).find((m) => m.zendeskKey === "side:9101")
    const [part] = await h.db
      .select()
      .from(messagePart)
      .where(eq(messagePart.zendeskAttachmentId, String(photo.id)))
    expect([part?.messageId, part?.status, part?.fileName]).toEqual([note?.id, "clean", "photo.txt"])
    expect(await readFile(h.files.storedPath(part?.storedSha256 ?? ""))).toEqual(photo.content)
    // The file with no ID is never dropped silently: the report names it, and the count holds it.
    expect((await reportOf(h, run.id)).filter((row) => row.startsWith("1:"))).toEqual([
      "1:file_unusable_id:unnamed.txt",
    ])
    expect((await runOf(h, run.id)).counts).toMatchObject({ files: filesBefore + 1 })
  })

  it("tries a file the scanner did not answer again from the archive, never Zendesk, and keeps a comment of files only", async () => {
    const h = await start()
    const slow = randomBytes(900)
    h.zendesk.addComment(1, {
      id: 15,
      public: true,
      body: "",
      files: [fileOf(151, "scan.bin", slow)],
      extra: { author_id: 2 },
    })
    await h.backup()
    const requests = h.zendesk.requests.length
    const id = await newRun(h)
    await withShortStreams(h, 600, () => expect(h.again(id)).rejects.toThrow(ScannerWaitingError))
    // The run stopped at the ticket, open, and wrote nothing of it.
    expect(await runOf(h, id)).toMatchObject({ state: "running", reason: "scanner", done: 0 })
    expect(await h.db.select().from(message)).toHaveLength(0)
    expect(await h.db.select().from(messagePart)).toHaveLength(0)
    // Its job again: the file is read from the archive, scanned once, and stored with its comment.
    const from = clamd.scanned.length
    expect(await h.again(id)).toEqual(DONE)
    expect(scansOf([slow], from)).toBe(1)
    const comment = (await messagesOf(h, 1)).find((m) => m.zendeskKey === "comment:15")
    expect([comment?.textBody, comment?.htmlBody]).toEqual([null, null])
    const [part] = await h.db.select().from(messagePart).where(eq(messagePart.zendeskAttachmentId, "151"))
    expect([part?.messageId, part?.status]).toEqual([comment?.id, "clean"])
    expect(await readFile(h.files.storedPath(part?.storedSha256 ?? ""))).toEqual(slow)
    expect(h.zendesk.requests.length).toBe(requests)
  })

  it("reports a file the manifest marks failed without asking Zendesk, and adds it once a later archive holds it", async () => {
    const h = await start()
    const requests = h.zendesk.requests.length
    const first = await h.run()
    expect((await reportOf(h, first.id)).filter((row) => row.startsWith("3:"))).toEqual([
      `3:file_failed:lost${REPLACEMENT}.txt`,
    ])
    expect(await h.db.select().from(messagePart).where(eq(messagePart.zendeskAttachmentId, "301"))).toHaveLength(0)
    expect(h.zendesk.requests.length).toBe(requests)
    // The next backup downloads it.
    const lost = h.zendesk.tickets.get(3)?.comments[0]?.files[0]
    if (!lost) throw new Error("no lost file")
    lost.serve = "redirect"
    await h.backup()
    const second = await h.run()
    expect(second.outcome).toEqual(DONE)
    expect((await reportOf(h, second.id)).filter((row) => row.startsWith("3:"))).toEqual([])
    const [comment] = await messagesOf(h, 3)
    const [part] = await h.db.select().from(messagePart).where(eq(messagePart.zendeskAttachmentId, "301"))
    expect([part?.messageId, part?.status, part?.fileName]).toEqual([comment?.id, "clean", `lost${REPLACEMENT}.txt`])
    expect(await readFile(h.files.storedPath(part?.storedSha256 ?? ""))).toEqual(lost.content)
  })

  it("follows a newer archive: files that change places, a comment that goes with its file, a file that leaves", async () => {
    const h = await start()
    h.zendesk.addComment(1, {
      id: 16,
      public: true,
      body: "One more",
      files: [fileOf(161, "more.txt", randomBytes(20))],
      extra: { author_id: 2 },
    })
    await h.backup()
    expect((await h.run()).outcome).toEqual(DONE)
    const ids = new Map((await partsOf(h)).map((p) => [p.zendeskAttachmentId, p.id]))
    const placesOf = async () => {
      const keyOf = new Map((await messagesOf(h, 1)).map((m) => [m.id, m.zendeskKey]))
      return (await partsOf(h)).map((p) => [
        p.zendeskAttachmentId,
        p.id === ids.get(p.zendeskAttachmentId),
        keyOf.get(p.messageId),
        p.index,
      ])
    }
    expect(await placesOf()).toEqual([
      ["101", true, "comment:11", 0],
      ["102", true, "comment:11", 1],
      ["161", true, "comment:16", 0],
      ["401", true, "side:9001", 0],
    ])
    // The question's two files swap places, and the comment with the third leaves Zendesk.
    h.zendesk.change(1, (t) => {
      t.comments[0]?.files.reverse()
      t.comments = t.comments.filter((c) => c.id !== 16)
    })
    await h.backup()
    const from = clamd.scanned.length
    expect((await h.run()).outcome).toEqual(DONE)
    expect(await placesOf()).toEqual([
      ["101", true, "comment:11", 1],
      ["102", true, "comment:11", 0],
      ["401", true, "side:9001", 0],
    ])
    expect(
      scansOf(
        h.zendesk.allFiles().map((f) => f.content),
        from,
      ),
    ).toBe(0)
    // A file that leaves its comment (Zendesk removed it) leaves the copy.
    h.zendesk.change(1, (t) => {
      const question = t.comments[0]
      if (question) question.files = question.files.filter((f) => f.id !== 101)
    })
    await h.backup()
    expect((await h.run()).outcome).toEqual(DONE)
    expect(await placesOf()).toEqual([
      ["102", true, "comment:11", 0],
      ["401", true, "side:9001", 0],
    ])
  })

  it("stores no file of a run cancelled while it scans, and a cancelled run's job never tries a waiting file again", async () => {
    const h = await start()
    const cancelled = await h.again(await newRun(h), {
      afterPlan: async (zendeskId) => {
        if (zendeskId === 1) await cancelOf(h)()
      },
    })
    expect(cancelled).toEqual({ state: "stopped", reason: "cancelled" })
    expect(await h.db.select().from(messagePart)).toHaveLength(0)
    expect(await h.db.select().from(storedFile)).toHaveLength(0)

    h.zendesk.addComment(1, {
      id: 15,
      public: true,
      body: "",
      files: [fileOf(151, "scan.bin", randomBytes(900))],
      extra: { author_id: 2 },
    })
    await h.backup()
    const id = await newRun(h)
    await withShortStreams(h, 600, () => expect(h.again(id)).rejects.toThrow(ScannerWaitingError))
    await cancelOf(h)()
    expect(await h.again(id)).toEqual({ skipped: true })
    expect(await h.db.select().from(messagePart)).toHaveLength(0)
    expect(await runOf(h, id)).toMatchObject({ state: "stopped", reason: "cancelled" })
  })

  it("stops at a file whose archived content is not what the manifest records, and goes on once it is", async () => {
    const h = await start()
    const invoice = h.zendesk.allFiles().find((f) => f.id === 101)
    if (!invoice) throw new Error("no invoice")
    const sha = sha256Of(invoice.content)
    const path = join(h.archive, "files", sha.slice(0, 2), sha)
    const id = await newRun(h)
    await expect(h.again(id, { afterCheck: () => writeFile(path, "changed") })).rejects.toThrow(ArchivedFileError)
    expect(await runOf(h, id)).toMatchObject({ state: "running", reason: "failed", done: 0 })
    expect(await reportOf(h, id)).toEqual(["1:ticket_failed:archive"])
    expect(await h.db.select().from(messagePart)).toHaveLength(0)
    await writeFile(path, invoice.content)
    expect(await h.again(id)).toEqual(DONE)
    expect(await h.db.select().from(messagePart).where(eq(messagePart.zendeskAttachmentId, "101"))).toHaveLength(1)
  })

  it("reads no more of an archived file than its manifest's size", async () => {
    const h = await start()
    const invoice = h.zendesk.allFiles().find((f) => f.id === 101)
    if (!invoice) throw new Error("no invoice")
    const sha = sha256Of(invoice.content)
    const path = join(h.archive, "files", sha.slice(0, 2), sha)
    const id = await newRun(h)
    // Replaced after the check by one far larger than a whole read could hold (sparse, so it takes no room).
    await expect(h.again(id, { afterCheck: () => truncate(path, 3 * 1024 ** 3) })).rejects.toThrow(ArchivedFileError)
    expect(await reportOf(h, id)).toEqual(["1:ticket_failed:archive"])
    expect(await h.db.select().from(messagePart)).toHaveLength(0)
  })

  it("refuses an archived file that is a link to a place outside the archive", async () => {
    const h = await start()
    const invoice = h.zendesk.allFiles().find((f) => f.id === 101)
    if (!invoice) throw new Error("no invoice")
    const sha = sha256Of(invoice.content)
    const path = join(h.archive, "files", sha.slice(0, 2), sha)
    // The same content, so only its place can refuse it.
    const outside = join(h.archive, "..", `outside-${sha}`)
    await writeFile(outside, invoice.content)
    await rm(path)
    await symlink(outside, path)
    const id = await newRun(h)
    await expect(h.again(id)).rejects.toThrow(ArchivedFileError)
    expect(await runOf(h, id)).toMatchObject({ state: "running", reason: "failed", done: 0 })
    expect(await reportOf(h, id)).toEqual(["1:ticket_failed:archive"])
    expect(await h.db.select().from(messagePart)).toHaveLength(0)
    expect(await h.db.select().from(storedFile)).toHaveLength(0)
    // The file back in the archive: the run goes on.
    await rm(path)
    await writeFile(path, invoice.content)
    expect(await h.again(id)).toEqual(DONE)
    expect(await h.db.select().from(messagePart).where(eq(messagePart.zendeskAttachmentId, "101"))).toHaveLength(1)
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
    expect(failureOf(new ArchivedFileError("changed"))).toBe("archive")
    expect(failureOf(Object.assign(new Error("no file"), { code: "ENOENT", path: "/archive/raw/x.json" }))).toBe(
      "archive",
    )
    expect(failureOf(new SyntaxError("Unexpected token"))).toBe("archive")
    // A network error is not the archive's.
    expect(failureOf(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe("other")
    expect(failureOf(new Error("something else"))).toBe("other")
  })
})

/**
 * A message as intake's stage one stores it, for stage two to process in the import's database (phase 6: Maane is
 * live while the import still runs). The stand-in Graph is not needed: stage two reads only the stored row.
 */
async function received(
  h: Harness,
  values: { from: string; subject: string; messageId?: string; text?: string },
): Promise<string> {
  let [source] = await h.db.select({ id: intakeSource.id }).from(intakeSource).limit(1)
  if (!source)
    [source] = await h.db
      .insert(intakeSource)
      .values({ tenantId: "example.onmicrosoft.com", mailbox: "intake@example.com", current: true })
      .returning({ id: intakeSource.id })
  const [row] = await h.db
    .insert(message)
    .values({
      sourceId: source?.id,
      graphId: randomUUID(),
      folder: "inbox",
      graph: {},
      receivedAt: new Date(),
      content: "parsed",
      messageIdHeader: values.messageId ?? `${randomUUID()}@mail.example.com`,
      fromAddress: values.from,
      toAddresses: [{ address: "store@example.com", name: null }],
      subject: values.subject,
      textBody: values.text ?? "A reply from the customer.",
      classification: "customer",
      contentHash: randomBytes(32).toString("hex"),
    })
    .returning({ id: message.id })
  if (!row) throw new Error("no message")
  return row.id
}

/** A promise a hook waits on until the test releases it. */
function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  let reach!: () => void
  const reached = new Promise<void>((resolve) => {
    reach = resolve
  })
  return { opened, open, reached, reach }
}

describe("live from day one (phase 6)", () => {
  it("keeps an imported ticket read-only for agents only: intake joins it, and a rerun keeps the ticket's own fields", async () => {
    const h = await start()
    expect((await h.run()).outcome).toEqual(DONE)
    const before = await ticketOf(h, 2)
    expect(before?.status).toBe("pending")
    // The customer (ticket 2's requester) answers through Maane: intake joins the imported ticket.
    const reply = await received(h, { from: "user3@example.com", subject: "Re: [#2] Order details" })
    expect(await new IntakeProcessor({ db: h.db }).run()).toEqual({ processed: 1, failed: 0 })
    const [record] = await h.db.select().from(intakeRecord).where(eq(intakeRecord.messageId, reply))
    expect(record).toMatchObject({ outcome: "joined", ticketId: before?.id, matchLayer: "subject" })
    const joined = await ticketOf(h, 2)
    expect(joined?.status).toBe("open")
    expect(joined?.lastActivityAt.getTime()).toBeGreaterThan(before?.lastActivityAt.getTime() ?? 0)
    // The import's waiting period ended with the customer's reply.
    expect(
      await h.db
        .select()
        .from(waitingPeriod)
        .where(and(eq(waitingPeriod.ticketId, before?.id ?? ""), isNull(waitingPeriod.endedAt))),
    ).toEqual([])

    // Zendesk changed the ticket meanwhile: a comment's text, its status, and its CCs.
    h.zendesk.change(2, (t) => {
      const first = t.comments[0]
      if (first) first.body = "Order details, corrected"
      t.status = "solved"
      t.record = { ...t.record, email_cc_ids: [2] }
    })
    await h.backup()
    const rerun = await h.run()
    expect(rerun.outcome).toEqual(DONE)
    expect(await reportOf(h, rerun.id)).toContain("2:kept_live_changes:")
    // The imported comments are updated; the reply intake added stays.
    const texts = (await messagesOf(h, 2)).map((row) => (row.zendeskKey ? row.textBody : `live:${row.id}`))
    expect(texts).toContain("Order details, corrected")
    expect(texts).toContain(`live:${reply}`)
    // The ticket's own fields stay as live mail left them: status, activity, participants, and no new import period.
    const after = await ticketOf(h, 2)
    expect(after?.status).toBe("open")
    expect(after?.lastActivityAt).toEqual(joined?.lastActivityAt)
    expect(await participantsOf(h, 2)).toEqual(["user3@example.com"])
    expect(
      await h.db
        .select()
        .from(waitingPeriod)
        .where(and(eq(waitingPeriod.ticketId, before?.id ?? ""), isNull(waitingPeriod.endedAt))),
    ).toEqual([])
    // A ticket intake never touched is replaced as before, and not reported.
    expect((await reportOf(h, rerun.id)).filter((row) => row.endsWith(":kept_live_changes:"))).toEqual([
      "2:kept_live_changes:",
    ])
  })

  it("flags the same mail through intake and the import, in both orders, and hides neither", async () => {
    const h = await start()
    expect((await h.run()).outcome).toEqual(DONE)
    const intake = new IntakeProcessor({ db: h.db })
    // Another sender with the same Message-ID as an imported comment is not the same mail.
    await received(h, { from: "user3@example.com", subject: "Re: [#1]", messageId: "question-1@mail.example.com" })
    await intake.run()
    expect((await ticketOf(h, 1))?.reviewFlags).not.toContain("possible_duplicate")
    // The import first: ticket 1's question came from user2 with this Message-ID; the same mail arrives live.
    const first = await received(h, {
      from: "user2@example.com",
      subject: "Re: [#1]",
      messageId: "question-1@mail.example.com",
    })
    await intake.run()
    const one = await ticketOf(h, 1)
    expect(one?.reviewFlags).toContain("possible_duplicate")
    const onOne = await messagesOf(h, 1)
    expect(onOne.filter((row) => row.zendeskMessageId === "question-1@mail.example.com")).toHaveLength(1)
    expect(onOne.map((row) => row.id)).toContain(first)
    // The Message-ID of an imported comment is never a threading key: it is not in message_id_header.
    expect(onOne.filter((row) => row.zendeskKey !== null && row.messageIdHeader !== null)).toEqual([])

    // Intake first: user3's mail joins ticket 2, then Zendesk's copy of the same mail comes in with a rerun.
    const second = await received(h, {
      from: "user3@example.com",
      subject: "Re: [#2]",
      messageId: "both-paths@mail.example.com",
    })
    await intake.run()
    expect((await ticketOf(h, 2))?.reviewFlags).not.toContain("possible_duplicate")
    h.zendesk.addComment(2, {
      id: 23,
      public: true,
      body: "The same mail, through Zendesk",
      files: [],
      extra: {
        author_id: 3,
        via: { channel: "email", source: { from: { address: "user3@example.com", name: "User 3" } } },
        metadata: { system: { message_id: "<both-paths@mail.example.com>" } },
      },
    })
    await h.backup()
    expect((await h.run()).outcome).toEqual(DONE)
    const two = await ticketOf(h, 2)
    expect(two?.reviewFlags).toContain("possible_duplicate")
    const onTwo = await messagesOf(h, 2)
    expect(onTwo.map((row) => row.id)).toContain(second)
    expect(onTwo.filter((row) => row.zendeskKey === "comment:23")).toHaveLength(1)
    // A rerun never removes the flag.
    expect((await h.run()).outcome).toEqual(DONE)
    expect((await ticketOf(h, 1))?.reviewFlags.filter((flag) => flag === "possible_duplicate")).toHaveLength(1)
  })

  it("imports a comment whose Message-ID is too long in bytes, keeping it only in the comment's source", async () => {
    const h = await start()
    // Pseudo-random CJK ideographs (U+4E00 to U+9FFF, three bytes each in UTF-8), built from code points: about 3,000
    // bytes that PostgreSQL cannot compress.
    let seed = 0x2545f491
    const ideographs = Array.from({ length: 998 - "@mail.example.com".length }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return String.fromCodePoint(0x4e00 + (seed % 0x5200))
    }).join("")
    const id = `${ideographs}@mail.example.com`
    expect(id).toHaveLength(998)
    h.zendesk.addComment(2, {
      id: 24,
      public: true,
      body: "A Message-ID as long as a header line may be",
      files: [],
      extra: {
        author_id: 3,
        via: { channel: "email", source: { from: { address: "user3@example.com", name: "User 3" } } },
        metadata: { system: { message_id: `<${id}>` } },
      },
    })
    await h.backup()
    expect((await h.run()).outcome).toEqual(DONE)
    const [row] = (await messagesOf(h, 2)).filter((entry) => entry.zendeskKey === "comment:24")
    expect(row?.zendeskMessageId).toBeNull()
    expect(row?.zendesk).toMatchObject({ email: { messageId: id } })
  })

  it("reads the sender's participation under the ticket's lock while a rerun removes that participant", async () => {
    const h = await start()
    expect((await h.run()).outcome).toEqual(DONE)
    expect(await participantsOf(h, 1)).toEqual(["user2@example.com", "user3@example.com"])
    // Zendesk drops user3 from ticket 1's CCs; the rerun holds ticket 1's transaction while user3's reply arrives.
    h.zendesk.change(1, (t) => {
      t.record = { ...t.record, email_cc_ids: [] }
    })
    await h.backup()
    const hold = gate()
    const rerun = h.run({
      inTicket: async (zendeskId) => {
        if (zendeskId !== 1) return
        hold.reach()
        await hold.opened
      },
    })
    await hold.reached
    const reply = await received(h, { from: "user3@example.com", subject: "Re: [#1]" })
    const processing = new IntakeProcessor({ db: h.db }).run()
    await lockWaited(h)
    hold.open()
    expect((await rerun).outcome).toEqual(DONE)
    expect(await processing).toEqual({ processed: 1, failed: 0 })
    expect(await participantsOf(h, 1)).toEqual(["user2@example.com"])
    // user3 is no longer a participant: the reply opens its own ticket, linked and flagged; ticket 1 is not joined.
    const [record] = await h.db.select().from(intakeRecord).where(eq(intakeRecord.messageId, reply))
    const one = await ticketOf(h, 1)
    expect(record).toMatchObject({
      outcome: "new_linked_ticket",
      reason: "sender_not_participant",
      matchedTicketId: one?.id,
    })
    expect(record?.ticketId).not.toBe(one?.id)
  })

  it("reports number_taken for a ticket intake opened with a Zendesk number", async () => {
    const h = await start()
    // Intake's next number is 3, a number the archive also holds.
    await h.db.execute(sql`select setval('ticket_number_seq', 2, true)`)
    const mail = await received(h, { from: "someone@example.com", subject: "A new question" })
    await new IntakeProcessor({ db: h.db }).run()
    const [record] = await h.db.select().from(intakeRecord).where(eq(intakeRecord.messageId, mail))
    const opened = await ticketOf(h, 3)
    expect(record).toMatchObject({ outcome: "new_ticket", ticketId: opened?.id })
    const run = await h.run()
    expect(run.outcome).toEqual(DONE)
    expect(await reportOf(h, run.id)).toContain("3:number_taken:")
    expect(await ticketOf(h, 3)).toMatchObject({ id: opened?.id, zendeskId: null, subject: "A new question" })
  })

  it("never moves the sequence back, also when intake draws a number while a run reads the highest one", async () => {
    const h = await start()
    // A sequence already past every imported number stays where it is.
    await h.db.execute(sql`select setval('ticket_number_seq', 500, true)`)
    expect((await h.run()).outcome).toEqual(DONE)
    expect(await nextNumber(h)).toBe(501)

    // Intake holds the number lock and draws a number while a rerun's ticket waits for it.
    const hold = gate()
    const mail = await received(h, { from: "someone@example.com", subject: "Drawn meanwhile" })
    const processing = new IntakeProcessor({ db: h.db }).run({
      afterLock: async () => {
        hold.reach()
        await hold.opened
      },
    })
    await hold.reached
    const rerun = h.run()
    await lockWaited(h)
    hold.open()
    expect(await processing).toEqual({ processed: 1, failed: 0 })
    expect((await rerun).outcome).toEqual(DONE)
    const [record] = await h.db.select().from(intakeRecord).where(eq(intakeRecord.messageId, mail))
    const [drawn] = await h.db
      .select()
      .from(ticket)
      .where(eq(ticket.id, record?.ticketId ?? ""))
    expect(drawn?.number).toBe(502)
    expect(await nextNumber(h)).toBe(503)
  })

  it("inserts an imported number while intake waits to draw the same one: no deadlock, no duplicate", async () => {
    const h = await start()
    // Before the first import intake's next number is 1, and the archive's first ticket is 1.
    const hold = gate()
    const run = h.run({
      inTicket: async (zendeskId) => {
        if (zendeskId !== 1) return
        hold.reach()
        await hold.opened
      },
    })
    await hold.reached
    const mail = await received(h, { from: "someone@example.com", subject: "Drawn meanwhile" })
    const processing = new IntakeProcessor({ db: h.db }).run()
    await lockWaited(h)
    hold.open()
    const [done, processed] = await Promise.all([run, processing])
    expect(done.outcome).toEqual(DONE)
    expect(processed).toEqual({ processed: 1, failed: 0 })
    // The import took 1 under the lock; intake drew the next free number after it, and the import reported that one.
    expect((await ticketOf(h, 1))?.zendeskId).toBe(1)
    const [record] = await h.db.select().from(intakeRecord).where(eq(intakeRecord.messageId, mail))
    const [drawn] = await h.db
      .select()
      .from(ticket)
      .where(eq(ticket.id, record?.ticketId ?? ""))
    expect(drawn).toMatchObject({ number: 2, zendeskId: null })
    expect(await reportOf(h, done.id)).toContain("2:number_taken:")
    const numbers = (await h.db.select({ number: ticket.number }).from(ticket)).map((row) => row.number)
    expect(new Set(numbers).size).toBe(numbers.length)
  })
})
