// One run of the import from the Zendesk archive (plan 5.1): the `zendesk-import` job, one at a time (an exclusive
// queue and a session lock that also cover retries). It makes Maane's imported copy match the archive, ticket by
// ticket, with no side effect: rows go straight to the database, never through intake or the send point, so nothing
// notifies, reopens, reminds, snoozes, schedules, or checks a delivery. One audit row per run, beside the block events
// of text the scanner refused.
//
// Before its first write a run checks, in this order: the window (intake listens and Maane never went live) and the
// chosen Maane user; the archive's state (`state.json`'s run count and coverage) and that no backup holds its lock;
// the strict offline check of the whole archive; that its origin is the origin of earlier imports; and that the state
// is still the same, with no lock (a change means a new full check). After each ticket it reads the state again: a
// backup that ran or started meanwhile stops the run, and the next start is a full pass. A run that stopped otherwise
// (a crash, the scanner, a ticket the database refused) goes on from the last ticket it committed while the archive
// still holds its state. An error stops the run where it is, open: it records why (`scanner` or `failed`), and a
// ticket that caused it gets a `ticket_failed` report row with the kind of error and no text of the error. When its
// job has used up its retries, the page offers Continue (the same Start) once the cause is fixed.
//
// Each ticket is one transaction, which first locks the intake mode row FOR SHARE and checks the window again: it
// writes the ticket and replaces its imported comments, notes, participants, categories, and fields from the newest
// version, with its position, counts, and report rows. A ticket counts as imported only once that committed. Each
// imported row keeps its source key (unique), so a run again updates the same rows.

import { SYSTEM, writeAudit } from "@maane/server/audit"
import type { Db } from "@maane/server/db/client"
import {
  importReport,
  importRun,
  message,
  ticket,
  ticketCategory,
  ticketLink,
  ticketParticipant,
  waitingPeriod,
  zendeskBrandMap,
  zendeskImport,
  zendeskTagMap,
} from "@maane/server/db/schema"
import type { ImportedMessageSource, ImportedTicketSource } from "@maane/server/imports/source"
import { importWindow } from "@maane/server/imports/window"
import { errorFacts, log } from "@maane/server/log"
import {
  emptyImportCounts,
  type FieldScan,
  type ImportCounts,
  type ImportFailure,
  type ImportReportReason,
  type ImportStopReason,
  type MessageFlag,
  type TextField,
} from "@maane/shared"
import {
  type ArchiveMark,
  ArchiveReader,
  checkArchive,
  type Manifest,
  sameMark,
  type ZendeskTicketRecord,
  type ZendeskUser,
} from "@maane/zendesk"
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import type { FileService } from "../files/service.ts"
import type { Tx } from "../files/types.ts"
import { auditBlockedFields, refused, scanFields, storable } from "../intake/content.ts"
import { sanitizeMailHtml, textFromHtml } from "../intake/sanitize.ts"
import { wellFormed } from "../intake/text.ts"
import { newReferenceCode } from "../intake/threading.ts"
import {
  addressOf,
  commentMessage,
  type FieldDefinition,
  type FileFacts,
  fieldDefinitions,
  fieldsOf,
  followersOf,
  linksOf,
  type PlannedMessage,
  participantsOf,
  sideMessages,
  statusOf,
  tagsOf,
} from "./map.ts"

/** How many times a run checks the archive again when its state changed during the check. */
const CHECK_ATTEMPTS = 3
/** The archive check's problems a refused run keeps for the page. */
const PROBLEMS_KEPT = 20
/** Link rows per insert: three parameters each, far below PostgreSQL's 65,535 parameters of one statement. */
export const LINK_BATCH = 1000

/** The scanner gave no answer for a text: the run stops here and goes on from this ticket when it answers. */
export class ScannerWaitingError extends Error {
  override name = "ScannerWaitingError"
}

export interface ImportHooks {
  /** After the archive check, before the state is read again (a test starts a backup here). */
  afterCheck?: () => Promise<void>
  /** After each ticket committed (a test crashes or changes the archive here). */
  afterTicket?: (zendeskId: number) => Promise<void>
}

export interface ImportOptions {
  db: Db
  files: FileService
  /** The read-only archive mount (MAANE_ZENDESK_ARCHIVE_DIR). */
  archiveDir: string
  hooks?: ImportHooks
}

export type ImportOutcome =
  | { state: "done" | "stopped" | "refused"; reason: ImportStopReason | null }
  | { skipped: true }

/** A ticket ready to write: everything read and scanned before its transaction. */
interface PlannedTicket {
  zendeskId: number
  record: ZendeskTicketRecord
  messages: (PlannedMessage & {
    failed: FileFacts["failed"]
    scans: Partial<Record<TextField, FieldScan>>
    invalid: boolean
  })[]
  files: number
  links: ImportedTicketSource["links"]
  /** The scan of the ticket's own texts (its subject, field values, and tags), as the header block of a message. */
  ticketScan: FieldScan | undefined
}

interface Context {
  users: Map<string, ZendeskUser>
  fields: Map<string, FieldDefinition>
  brands: Map<string, string | null>
  brandMap: Map<string, string>
  tagMap: Map<string, string>
  manifest: Manifest
  agentUserId: string
}

type Report = { reason: ImportReportReason; detail: string | null }

const DELETED = new Set(["deleted"])

export class ZendeskImport {
  readonly #db: Db
  readonly #files: FileService
  readonly #dir: string
  readonly #hooks: ImportHooks

  constructor(options: ImportOptions) {
    this.#db = options.db
    this.#files = options.files
    this.#dir = options.archiveDir
    this.#hooks = options.hooks ?? {}
  }

  async run(runId: string): Promise<ImportOutcome> {
    const [run] = await this.#db.select().from(importRun).where(eq(importRun.id, runId))
    if (run?.state !== "running") return { skipped: true }
    const at: { ticket: number | null } = { ticket: null }
    try {
      return await this.#go(run, at)
    } catch (error) {
      await this.#stoppedOn(runId, at.ticket, error)
      throw error
    }
  }

  /**
   * Records why an open run stopped on an error, in a transaction of its own (the ticket's rolled back): the reason,
   * and for a ticket the database or the archive refused, one `ticket_failed` row (the newest error of the run). A
   * failure to record it is logged; the run's own error is what its job reports.
   */
  async #stoppedOn(runId: string, zendeskId: number | null, error: unknown): Promise<void> {
    const waiting = error instanceof ScannerWaitingError
    try {
      await this.#db.transaction(async (tx) => {
        const [open] = await tx
          .update(importRun)
          .set({ reason: waiting ? "scanner" : "failed" })
          .where(and(eq(importRun.id, runId), eq(importRun.state, "running")))
          .returning({ id: importRun.id })
        if (!open || waiting || zendeskId === null) return
        await tx
          .delete(importReport)
          .where(and(eq(importReport.runId, runId), eq(importReport.reason, "ticket_failed")))
        await tx.insert(importReport).values({ runId, zendeskId, reason: "ticket_failed", detail: failureOf(error) })
      })
    } catch (recordError) {
      log.warn("an import run's error could not be recorded", errorFacts(recordError))
    }
  }

  async #go(run: typeof importRun.$inferSelect, at: { ticket: number | null }): Promise<ImportOutcome> {
    const runId = run.id
    const reader = new ArchiveReader(this.#dir)

    const window = await importWindow(this.#db)
    if (!window.open) return this.#finish(runId, "refused", window.wentLiveAt ? "went_live" : "not_listening")
    const [config] = await this.#db.select().from(zendeskImport).where(eq(zendeskImport.id, 1))
    if (!config?.agentUserId) return this.#finish(runId, "refused", "no_agent")

    // The archive: its state, the strict check, its origin, and its state again before the first write.
    const info = await reader.info()
    if (!info) return this.#finish(runId, "refused", "no_archive")
    let mark = await reader.mark()
    for (let attempt = 1; ; attempt++) {
      if (mark.locked) return this.#finish(runId, "refused", "backup_running")
      const check = await checkArchive(this.#dir)
      if (check.problems.length > 0)
        return this.#finish(runId, "refused", "archive_incomplete", check.problems.slice(0, PROBLEMS_KEPT))
      if (config.origin !== null && config.origin !== info.apiOrigin)
        return this.#finish(runId, "refused", "other_origin")
      await this.#hooks.afterCheck?.()
      const after = await reader.mark()
      if (sameMark(mark, after)) break
      if (attempt >= CHECK_ATTEMPTS) return this.#finish(runId, "refused", "archive_changed")
      mark = after
    }

    // A run that goes on after a crash imports the same archive state, or stops: the next start is a full pass.
    if (run.archiveRuns !== null && !sameRecorded(run, mark)) return this.#finish(runId, "stopped", "archive_changed")
    // Going on after an error: what stopped it no longer shows while the run works.
    if (run.archiveRuns !== null)
      await this.#db.transaction(async (tx) => {
        await tx.update(importRun).set({ reason: null }).where(eq(importRun.id, runId))
        await tx
          .delete(importReport)
          .where(and(eq(importReport.runId, runId), eq(importReport.reason, "ticket_failed")))
      })

    const records = await reader.tickets()
    const order = [...records.keys()].map(Number).sort((a, b) => a - b)
    const highest = order.at(-1) ?? null
    const context: Context = {
      users: await reader.users(),
      fields: fieldDefinitions(await reader.collection("ticket_fields")),
      brands: new Map(
        (await reader.collection("brands")).flatMap((brand) =>
          brand.id === undefined ? [] : [[String(brand.id), typeof brand.name === "string" ? brand.name : null]],
        ),
      ),
      brandMap: new Map(
        (await this.#db.select().from(zendeskBrandMap)).map((row) => [row.brandId, row.organizationId]),
      ),
      tagMap: new Map((await this.#db.select().from(zendeskTagMap)).map((row) => [row.tag, row.categoryId])),
      manifest: await reader.archive.manifest(),
      agentUserId: config.agentUserId,
    }
    const state = await reader.state()

    if (run.archiveRuns === null) {
      await this.#db.transaction(async (tx) => {
        await tx
          .update(importRun)
          .set({
            archiveOrigin: info.apiOrigin,
            archiveRuns: mark.runs,
            coveredUntil: mark.coveredUntil ? new Date(mark.coveredUntil) : null,
            highestNumber: highest,
            total: order.length,
            reason: null,
          })
          .where(eq(importRun.id, runId))
        // The first import fixes the archive's origin; every later run must match it.
        await tx
          .update(zendeskImport)
          .set({ origin: sql`coalesce(${zendeskImport.origin}, ${info.apiOrigin})`, updatedAt: new Date() })
          .where(eq(zendeskImport.id, 1))
      })
    }

    const position = run.position ?? 0
    for (const zendeskId of order) {
      if (zendeskId <= position) continue
      const record = records.get(String(zendeskId)) as ZendeskTicketRecord
      const gone = state.tickets[String(zendeskId)]?.gone === true
      at.ticket = zendeskId
      let planned: PlannedTicket | null = null
      if (!DELETED.has(record.status ?? "") && !gone) planned = await this.#plan(reader, zendeskId, record, context)
      const written = await this.#write(runId, zendeskId, record, planned, context)
      at.ticket = null
      if (written === "closed") return this.#finish(runId, "stopped", "went_live")
      await this.#hooks.afterTicket?.(zendeskId)
      if (!sameMark(mark, await reader.mark())) return this.#finish(runId, "stopped", "archive_changed")
    }

    // The links between imported tickets, once every ticket is in, and the numbers after the highest one.
    const closed = await this.#db.transaction(async (tx) => {
      if (!(await importWindow(tx, true)).open) return true
      const links = await this.#link(tx)
      await addCounts(tx, runId, { links })
      await continueNumbers(tx)
      return false
    })
    if (closed) return this.#finish(runId, "stopped", "went_live")
    return this.#finish(runId, "done", null)
  }

  /** Reads one ticket's newest version and scans its texts, outside any transaction. */
  async #plan(
    reader: ArchiveReader,
    zendeskId: number,
    record: ZendeskTicketRecord,
    context: Context,
  ): Promise<PlannedTicket> {
    const version = await reader.version(String(zendeskId), record.updated_at)
    // A comment or a side conversation event without its own time is placed at the version's time.
    const fallback = new Date(record.updated_at)
    const planned = [
      ...version.comments.map((comment) =>
        commentMessage(zendeskId, comment, context.users, context.manifest, fallback),
      ),
      ...sideMessages(zendeskId, version.sideConversations, context.manifest, fallback),
    ]
    const messages: PlannedTicket["messages"] = []
    for (const item of planned) {
      // The same policy intake applies: well-formed text, the sanitizer, and the scanner over every stored text field.
      const fixed = wellFormed({ text: item.text, html: item.html, headers: item.headers, source: item.source })
      const html = fixed.value.html ? sanitizeMailHtml(fixed.value.html) : null
      const plain = fixed.value.text ?? (html ? textFromHtml(html) : null)
      const texts: Partial<Record<TextField, string>> = {}
      if (plain) texts.text = plain
      if (html) texts.html = html
      const block = fixed.value.headers.join("\n")
      if (block) texts.headers = block
      const scans = await scanFields(this.#files, texts)
      if (Object.values(scans).some((scan) => scan?.status === "waiting")) throw new ScannerWaitingError()
      messages.push({
        ...item,
        text: plain,
        html,
        headers: fixed.value.headers,
        source: fixed.value.source,
        scans,
        invalid: fixed.changed,
      })
    }
    const ticketScan = (await scanFields(this.#files, ticketTexts(record, context))).headers
    if (ticketScan?.status === "waiting") throw new ScannerWaitingError()
    return {
      zendeskId,
      record,
      messages,
      files: planned.reduce((sum, item) => sum + item.source.files.length, 0),
      links: linksOf(record, version.audits),
      ticketScan,
    }
  }

  /**
   * One ticket's transaction: the window again under the mode row's lock, then the ticket and what belongs to it, the
   * run's position, its counts, and its report rows. Returns "closed" when the window closed.
   */
  async #write(
    runId: string,
    zendeskId: number,
    record: ZendeskTicketRecord,
    planned: PlannedTicket | null,
    context: Context,
  ): Promise<"written" | "skipped" | "closed"> {
    return this.#db.transaction(async (tx) => {
      if (!(await importWindow(tx, true)).open) return "closed"
      const reports: Report[] = []
      const counts: Partial<ImportCounts> = {}
      const done = async (outcome: "written" | "skipped") => {
        if (reports.length > 0)
          await tx
            .insert(importReport)
            .values(wellFormed(reports).value.map((report) => ({ runId, zendeskId, ...report })))
        if (outcome === "skipped") counts.skipped = 1
        await addCounts(tx, runId, counts)
        await tx
          .update(importRun)
          .set({ position: zendeskId, done: sql`${importRun.done} + 1` })
          .where(eq(importRun.id, runId))
        return outcome
      }

      if (!planned) {
        // Deleted in Zendesk (owner's decision 3): not imported, listed; nothing already imported is hidden or erased.
        reports.push({ reason: "deleted_in_zendesk", detail: null })
        return done("skipped")
      }
      const brandId = record.brand_id === null || record.brand_id === undefined ? "" : String(record.brand_id)
      const organizationId = context.brandMap.get(brandId)
      if (!organizationId) {
        reports.push({ reason: "unmapped_brand", detail: context.brands.get(brandId) ?? (brandId || null) })
        return done("skipped")
      }
      const [existing] = await tx
        .select({ id: ticket.id, zendesk: ticket.zendesk })
        .from(ticket)
        .where(eq(ticket.zendeskId, zendeskId))
        .for("update")
      if (!existing) {
        const [taken] = await tx.select({ id: ticket.id }).from(ticket).where(eq(ticket.number, zendeskId))
        if (taken) {
          reports.push({ reason: "number_taken", detail: null })
          return done("skipped")
        }
      }

      const status = statusOf(record.status)
      const tags = tagsOf(record)
      const source: ImportedTicketSource = {
        brand: { id: brandId, name: context.brands.get(brandId) ?? null },
        tags,
        fields: fieldsOf(record, context.fields),
        followers: followersOf(record, context.users),
        links: planned.links,
        status: record.status ?? "",
        updatedAt: record.updated_at,
      }
      // The ticket's own texts are stored only when their scan allows it (the header block's rule).
      const ticketOk = storable(planned.ticketScan)
      let people = participantsOf(record, context.users)
      if (!ticketOk) {
        source.fields = []
        source.tags = []
        source.followers = source.followers.map((follower) => ({ ...follower, name: null }))
        source.blocked = true
        people = people.map((person) => ({ ...person, name: null }))
        reports.push({ reason: "blocked_content", detail: "ticket" })
      }
      const fixed = wellFormed({ subject: ticketOk ? (record.subject ?? null) : null, source }).value
      const createdAt = new Date(record.created_at ?? record.updated_at)
      const columns = {
        organizationId,
        supportAddress: addressOf(record.recipient) ?? "",
        subject: fixed.subject,
        status,
        createdAt,
        lastActivityAt: new Date(record.updated_at),
        zendesk: fixed.source,
      }
      let ticketId: string
      const blockedBefore = (existing?.zendesk as ImportedTicketSource | null | undefined)?.blocked === true
      if (existing) {
        await tx.update(ticket).set(columns).where(eq(ticket.id, existing.id))
        ticketId = existing.id
      } else {
        const [made] = await tx
          .insert(ticket)
          .values({ ...columns, number: zendeskId, zendeskId, referenceCode: newReferenceCode() })
          .returning({ id: ticket.id })
        if (!made) throw new Error("the ticket was not written")
        ticketId = made.id
      }
      // The block event of the ticket's own texts, once (as a message's fields have theirs).
      if (!ticketOk && !blockedBefore)
        await writeAudit(tx, SYSTEM, {
          action: "ticket.content_blocked",
          entityType: "ticket",
          entityId: ticketId,
          details: { ticket: zendeskId, reason: planned.ticketScan?.status, signature: planned.ticketScan?.signature },
        })

      // Participants (the requester and the CCs) and categories (from the tag mapping) are the source's. The composer
      // takes the earliest participant as the recipient (then the address), so each is a millisecond after the one
      // before it: the requester first, then the CCs in Zendesk's order.
      await tx.delete(ticketParticipant).where(eq(ticketParticipant.ticketId, ticketId))
      people = wellFormed(people).value
      const since = Date.now()
      if (people.length > 0)
        await tx
          .insert(ticketParticipant)
          .values(people.map((person, index) => ({ ticketId, ...person, createdAt: new Date(since + index) })))
      await tx.delete(ticketCategory).where(eq(ticketCategory.ticketId, ticketId))
      const categories = [...new Set(tags.flatMap((tag) => context.tagMap.get(tag) ?? []))]
      if (categories.length > 0)
        await tx.insert(ticketCategory).values(categories.map((categoryId) => ({ ticketId, categoryId })))

      // A pending ticket waits for its customer as Zendesk left it: an imported period never sends a reminder.
      const [open] = await tx
        .select({ id: waitingPeriod.id, origin: waitingPeriod.origin })
        .from(waitingPeriod)
        .where(and(eq(waitingPeriod.ticketId, ticketId), isNull(waitingPeriod.endedAt)))
      if (status === "pending" && !open)
        await tx.insert(waitingPeriod).values({ ticketId, origin: "import", startedAt: new Date(record.updated_at) })
      if (status !== "pending" && open?.origin === "import")
        await tx
          .update(waitingPeriod)
          .set({ endedAt: sql`now()`, endReason: "status_change" })
          .where(eq(waitingPeriod.id, open.id))

      // The comments, notes, and side conversation messages, by their source keys.
      const before = new Map(
        (
          await tx
            .select({ id: message.id, key: message.zendeskKey, fieldScans: message.fieldScans })
            .from(message)
            .where(and(eq(message.ticketId, ticketId), isNotNull(message.zendeskKey)))
        ).map((row) => [row.key as string, row]),
      )
      const keys = planned.messages.map((item) => item.key)
      const fileReports: Report[] = []
      for (const item of planned.messages) {
        const flags: MessageFlag[] = []
        if (item.invalid) flags.push("invalid_characters")
        const blocked = Object.values(item.scans).some((scan) => refused(scan))
        if (blocked) flags.push("blocked_content")
        const headersOk = storable(item.scans.headers)
        const raw = {
          direction: item.direction,
          ticketId,
          receivedAt: item.at,
          sentAt: item.at,
          state: "processed",
          processedAt: new Date(),
          content: "parsed",
          fromAddress: item.from?.address ?? null,
          // An author without an address keeps the name, and nothing is invented for the address.
          fromName: headersOk ? (item.from?.name ?? (item.direction === "in" ? item.source.author.name : null)) : null,
          toAddresses: item.to.map((entry) => ({ address: entry.address, name: headersOk ? entry.name : null })),
          ccAddresses: item.cc,
          subject: headersOk ? (item.source.sideConversation?.subject ?? null) : null,
          textBody: storable(item.scans.text) ? item.text : null,
          htmlBody: storable(item.scans.html) ? item.html : null,
          fieldScans: item.scans,
          reviewFlags: flags,
          authorUserId: item.direction === "in" ? null : context.agentUserId,
          zendesk: headersOk ? item.source : withoutNames(item.source),
        }
        // Every string of the row well formed, as intake's: a name or an address may hold U+0000 too.
        const clean = wellFormed(raw)
        if (clean.changed && !flags.includes("invalid_characters")) flags.push("invalid_characters")
        const values = { ...clean.value, reviewFlags: flags }
        const [row] = await tx
          .insert(message)
          .values({ ...values, zendeskKey: item.key })
          .onConflictDoUpdate({ target: message.zendeskKey, set: values })
          .returning({ id: message.id })
        if (!row) throw new Error("the message was not written")
        // The block event, once per field the scanner refused (plan 2.3's policy, P12).
        await auditBlockedFields(
          tx,
          row.id,
          (before.get(item.key)?.fieldScans ?? {}) as Partial<Record<TextField, FieldScan>>,
          item.scans,
        )
        if (blocked) reports.push({ reason: "blocked_content", detail: item.key })
        // A file the manifest marks failed, by its name; by its ID when the scanner blocked the names (P12).
        for (const file of item.failed)
          fileReports.push({ reason: "file_failed", detail: headersOk ? (file.name ?? file.id) : file.id })
        if (item.direction === "note") {
          if (item.source.sideConversation) counts.sideConversations = (counts.sideConversations ?? 0) + 1
          else counts.notes = (counts.notes ?? 0) + 1
        } else counts.messages = (counts.messages ?? 0) + 1
      }
      // A comment that left the source (Zendesk deleted it) leaves the copy too.
      const gone = [...before.keys()].filter((key) => !keys.includes(key))
      if (gone.length > 0)
        await tx.delete(message).where(and(eq(message.ticketId, ticketId), inArray(message.zendeskKey, gone)))

      reports.push(...fileReports)
      counts.tickets = 1
      counts.files = planned.files
      // The numbers go on after the highest one as each ticket commits, so a run that stops leaves no number to reuse.
      await continueNumbers(tx)
      return done("written")
    })
  }

  /**
   * Replaces the links between imported tickets with the merged and follow-up tickets their sources name. The old ones
   * go by subqueries and the new ones in batches, so no statement carries a parameter per imported ticket.
   */
  async #link(tx: Tx): Promise<number> {
    const imported = await tx
      .select({ id: ticket.id, zendeskId: ticket.zendeskId, zendesk: ticket.zendesk })
      .from(ticket)
      .where(isNotNull(ticket.zendeskId))
    const byZendesk = new Map(imported.map((row) => [row.zendeskId as number, row.id]))
    const importedIds = tx.select({ id: ticket.id }).from(ticket).where(isNotNull(ticket.zendeskId))
    await tx
      .delete(ticketLink)
      .where(
        and(
          inArray(ticketLink.ticketId, importedIds),
          inArray(ticketLink.linkedTicketId, importedIds),
          inArray(ticketLink.reason, ["merged", "follow_up"]),
        ),
      )
    const pairs = new Map<string, { ticketId: string; linkedTicketId: string; reason: string }>()
    for (const row of imported) {
      const links = ((row.zendesk as ImportedTicketSource | null)?.links ?? []) as ImportedTicketSource["links"]
      for (const link of links) {
        const other = byZendesk.get(link.zendeskId)
        if (!other || other === row.id) continue
        // One row per pair, either way round: the first source that names it.
        const pair = [row.id, other].sort().join(":")
        if (!pairs.has(pair)) pairs.set(pair, { ticketId: row.id, linkedTicketId: other, reason: link.reason })
      }
    }
    const values = [...pairs.values()]
    for (const batch of batches(values, LINK_BATCH)) await tx.insert(ticketLink).values(batch).onConflictDoNothing()
    return values.length
  }

  async #finish(
    runId: string,
    state: "done" | "stopped" | "refused",
    reason: ImportStopReason | null,
    problems: string[] | null = null,
  ): Promise<ImportOutcome> {
    await this.#db.transaction(async (tx) => {
      const [run] = await tx
        .update(importRun)
        .set({ state, reason, problems, finishedAt: sql`now()` })
        .where(and(eq(importRun.id, runId), eq(importRun.state, "running")))
        .returning()
      if (!run) return
      await writeAudit(tx, SYSTEM, {
        action: "import.run",
        entityType: "import_run",
        entityId: runId,
        details: {
          state,
          reason,
          tickets: run.done,
          total: run.total,
          coveredUntil: run.coveredUntil?.toISOString() ?? null,
          highestNumber: run.highestNumber,
          counts: run.counts,
        },
      })
    })
    if (state !== "done") log.info("import run ended", { state, reason })
    return { state, reason }
  }
}

/**
 * An imported comment's source without the names the header block holds, when its scan refused that block: the
 * author's, the files', the side conversation's subject, and the email's names.
 */
function withoutNames(source: ImportedMessageSource): ImportedMessageSource {
  return {
    ...source,
    author: { ...source.author, name: null },
    sideConversation: source.sideConversation ? { ...source.sideConversation, subject: null } : null,
    files: source.files.map((file) => ({ ...file, name: null })),
    email:
      source.email.kind === "recorded"
        ? {
            ...source.email,
            from: source.email.from ? { ...source.email.from, name: null } : null,
            to: source.email.to ? { ...source.email.to, name: null } : null,
          }
        : source.email,
  }
}

/**
 * The ticket's own texts the scanner reads, one per line: its subject, its fields' names and values, its tags, and the
 * names of its participants and followers.
 */
function ticketTexts(record: ZendeskTicketRecord, context: Context): Partial<Record<TextField, string>> {
  const values = [
    record.subject ?? "",
    ...fieldsOf(record, context.fields).flatMap((field) => [field.name, field.value]),
    ...tagsOf(record),
    ...participantsOf(record, context.users).map((person) => person.name ?? ""),
    ...followersOf(record, context.users).map((follower) => follower.name ?? ""),
  ]
  const block = wellFormed(values.filter((value) => value !== "").join("\n")).value
  return block ? { headers: block } : {}
}

/** Whether the run's recorded archive state is the archive's state now. */
function sameRecorded(run: { archiveRuns: number | null; coveredUntil: Date | null }, mark: ArchiveMark): boolean {
  const covered = mark.coveredUntil ? new Date(mark.coveredUntil).getTime() : null
  return run.archiveRuns === mark.runs && (run.coveredUntil?.getTime() ?? null) === covered
}

/** Adds to a run's counts in the caller's transaction. */
async function addCounts(tx: Tx, runId: string, add: Partial<ImportCounts>): Promise<void> {
  const [row] = await tx
    .select({ counts: importRun.counts })
    .from(importRun)
    .where(eq(importRun.id, runId))
    .for("update")
  const counts = { ...emptyImportCounts(), ...((row?.counts ?? {}) as Partial<ImportCounts>) }
  for (const [key, value] of Object.entries(add) as [keyof ImportCounts, number][]) counts[key] += value
  await tx.update(importRun).set({ counts }).where(eq(importRun.id, runId))
}

/**
 * The ticket numbers go on right after the highest ticket number, with no gap (owner's decision 1). `setval` is not
 * transactional: it is set to a number a ticket holds, so a rollback after it leaves a gap at worst, never a reuse.
 * Called after each ticket, so both reads use the number's unique index: `max` and `exists`, never a count.
 */
async function continueNumbers(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select setval('ticket_number_seq', greatest((select coalesce(max(${ticket.number}), 0) from ${ticket}), 1), exists (select 1 from ${ticket}))`,
  )
}

/** A list in batches of at most `size` items, in order. */
export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size))
  return out
}

/**
 * What kind of error stopped a ticket, for its report row: the database's (by its SQLSTATE, with the constraint's name
 * when it named one) or the archive's (a file-system error, which names its path, or JSON that does not parse). A
 * network error (the scanner's, the database's) is `other`. Never the error's text: it may hold the row's values.
 */
export function failureOf(error: unknown): string {
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth++) {
    const facts = current as { code?: unknown; constraint?: unknown; path?: unknown; cause?: unknown }
    if (typeof facts.code === "string" && /^[0-9A-Z]{5}$/.test(facts.code)) {
      const code = facts.code
      const kind: ImportFailure =
        code === "23505"
          ? "duplicate"
          : code === "23503"
            ? "reference"
            : code.startsWith("23")
              ? "rule"
              : code.startsWith("22")
                ? "value"
                : "other"
      const constraint = typeof facts.constraint === "string" ? facts.constraint : ""
      return /^[a-z0-9_]{1,63}$/.test(constraint) ? `${kind}:${constraint}` : kind
    }
    if (
      (typeof facts.code === "string" && /^E[A-Z]+$/.test(facts.code) && typeof facts.path === "string") ||
      current instanceof SyntaxError
    )
      return "archive"
    current = facts.cause
  }
  return "other"
}

/** Runs the job of a run, and logs what stopped it. */
export async function importJob(importer: ZendeskImport, runId: string): Promise<ImportOutcome> {
  try {
    return await importer.run(runId)
  } catch (error) {
    log.warn("an import run stopped; it goes on from its last ticket", errorFacts(error))
    throw error
  }
}
