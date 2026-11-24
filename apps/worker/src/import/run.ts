import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { sep } from "node:path"
import { SYSTEM, writeAudit } from "@maane/server/audit"
import type { Db } from "@maane/server/db/client"
import {
  importReport,
  importRun,
  message,
  messagePart,
  ticket,
  ticketCategory,
  ticketLink,
  ticketParticipant,
  waitingPeriod,
  zendeskBrandMap,
  zendeskImport,
  zendeskTagMap,
} from "@maane/server/db/schema"
import { flagSameMail } from "@maane/server/imports/overlap"
import type { ImportedMessageSource, ImportedTicketSource } from "@maane/server/imports/source"
import { errorFacts, log } from "@maane/server/log"
import { lockTicketNumbers } from "@maane/server/tickets/numbers"
import {
  emptyImportCounts,
  type FieldScan,
  type ImportCounts,
  type ImportFailure,
  type ImportReportReason,
  type ImportStage,
  type ImportStopReason,
  type MessageFlag,
  type PartStatus,
  STORED_STATUSES,
  type StoredStatus,
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
import { and, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm"
import { auditBlockedPart, type FileService, FileTooLargeError, type ScanOutcome, sha256Of } from "../files/service.ts"
import type { Tx } from "../files/types.ts"
import { auditBlockedFields, refused, scanFields, storable } from "../intake/content.ts"
import { messageIds } from "../intake/parse.ts"
import { sanitizeMailHtml, textFromHtml } from "../intake/sanitize.ts"
import { wellFormed } from "../intake/text.ts"
import { newReferenceCode } from "../intake/threading.ts"
import {
  type ArchivedFile,
  addressOf,
  commentMessage,
  type FieldDefinition,
  type FileFacts,
  fieldDefinitions,
  fieldsOf,
  followersOf,
  importedContentId,
  inlineImages,
  linksOf,
  type PlannedMessage,
  participantsOf,
  sideMessages,
  statusOf,
  tagsOf,
} from "./map.ts"

const CHECK_ATTEMPTS = 3
const PROBLEMS_KEPT = 20
export const LINK_BATCH = 1000

export class ScannerWaitingError extends Error {
  override name = "ScannerWaitingError"
}

export class ArchivedFileError extends Error {
  override name = "ArchivedFileError"
}

export interface ImportHooks {
  afterCheck?: () => Promise<void>
  afterTicket?: (zendeskId: number) => Promise<void>
  afterLinks?: () => Promise<void>
  inTicket?: (zendeskId: number) => Promise<void>
  afterPlan?: (zendeskId: number) => Promise<void>
}

export interface ImportOptions {
  db: Db
  files: FileService
  archiveDir: string
  hooks?: ImportHooks
}

export type ImportOutcome =
  | { state: "done" | "stopped" | "refused"; reason: ImportStopReason | null }
  | { skipped: true }

const CANCELLED: ImportOutcome = { state: "stopped", reason: "cancelled" }

type StoredPart = typeof messagePart.$inferSelect

type FileDecision =
  | { kind: "kept"; part: StoredPart }
  | { kind: "too_large" }
  | { kind: "scanned"; outcome: ScanOutcome }

interface PlannedFile extends ArchivedFile {
  index: number
  shown: boolean
  decision: FileDecision
  before: StoredPart | null
}

const isStored = (status: string): status is StoredStatus => (STORED_STATUSES as readonly string[]).includes(status)

const fileStatus = (file: PlannedFile): PartStatus =>
  file.decision.kind === "kept"
    ? (file.decision.part.status as PartStatus)
    : file.decision.kind === "too_large"
      ? "too_large"
      : (file.decision.outcome.status as PartStatus)

interface PlannedTicket {
  zendeskId: number
  record: ZendeskTicketRecord
  messages: (PlannedMessage & {
    failed: FileFacts["failed"]
    unusable: FileFacts["unusable"]
    files: PlannedFile[]
    scans: Partial<Record<TextField, FieldScan>>
    invalid: boolean
  })[]
  files: number
  links: ImportedTicketSource["links"]
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

type At = { ticket: number | null; stage: ImportStage }

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
    const at: At = { ticket: null, stage: "start" }
    try {
      return await this.#go(run, at)
    } catch (error) {
      await this.#stoppedOn(runId, at, error)
      throw error
    }
  }

  async #stoppedOn(runId: string, at: At, error: unknown): Promise<void> {
    const waiting = error instanceof ScannerWaitingError
    const zendeskId = at.ticket
    try {
      await this.#db.transaction(async (tx) => {
        const [open] = await tx
          .update(importRun)
          .set({
            reason: waiting ? "scanner" : "failed",
            failure: waiting || zendeskId !== null ? null : `${at.stage}:${failureOf(error)}`,
          })
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

  async #go(run: typeof importRun.$inferSelect, at: At): Promise<ImportOutcome> {
    const runId = run.id
    const reader = new ArchiveReader(this.#dir)

    const [config] = await this.#db.select().from(zendeskImport).where(eq(zendeskImport.id, 1))
    if (!config?.agentUserId) return this.#finish(runId, "refused", "no_agent")

    at.stage = "archive"
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

    if (run.archiveRuns !== null && !sameRecorded(run, mark)) return this.#finish(runId, "stopped", "archive_changed")
    at.stage = "start"
    if (run.archiveRuns !== null) {
      const going = await this.#db.transaction(async (tx) => {
        if (!(await stillRunning(tx, runId))) return false
        await tx.update(importRun).set({ reason: null, failure: null }).where(eq(importRun.id, runId))
        await tx
          .delete(importReport)
          .where(and(eq(importReport.runId, runId), eq(importReport.reason, "ticket_failed")))
        return true
      })
      if (!going) return CANCELLED
    }

    at.stage = "archive"
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

    at.stage = "start"
    if (run.archiveRuns === null) {
      const going = await this.#db.transaction(async (tx) => {
        if (!(await stillRunning(tx, runId))) return false
        await tx
          .update(importRun)
          .set({
            archiveOrigin: info.apiOrigin,
            archiveRuns: mark.runs,
            coveredUntil: mark.coveredUntil ? new Date(mark.coveredUntil) : null,
            highestNumber: highest,
            total: order.length,
            reason: null,
            failure: null,
          })
          .where(eq(importRun.id, runId))
        await tx
          .update(zendeskImport)
          .set({ origin: sql`coalesce(${zendeskImport.origin}, ${info.apiOrigin})`, updatedAt: new Date() })
          .where(eq(zendeskImport.id, 1))
        return true
      })
      if (!going) return CANCELLED
    }

    const position = run.position ?? 0
    at.stage = "archive"
    for (const zendeskId of order) {
      if (zendeskId <= position) continue
      const record = records.get(String(zendeskId)) as ZendeskTicketRecord
      const gone = state.tickets[String(zendeskId)]?.gone === true
      at.ticket = zendeskId
      let planned: PlannedTicket | null = null
      if (!DELETED.has(record.status ?? "") && !gone) planned = await this.#plan(reader, zendeskId, record, context)
      await this.#hooks.afterPlan?.(zendeskId)
      const written = await this.#write(reader, runId, zendeskId, record, planned, context)
      at.ticket = null
      if (written === "cancelled") return CANCELLED
      await this.#hooks.afterTicket?.(zendeskId)
      if (!sameMark(mark, await reader.mark())) return this.#finish(runId, "stopped", "archive_changed")
    }

    at.stage = "links"
    const linked = await this.#db.transaction(async (tx) => {
      if (!(await stillRunning(tx, runId))) return false
      await lockTicketNumbers(tx)
      await addCounts(tx, runId, {}, { links: await this.#link(tx) })
      await continueNumbers(tx)
      return true
    })
    if (!linked) return CANCELLED
    await this.#hooks.afterLinks?.()
    return this.#finish(runId, "done", null)
  }

  async #plan(
    reader: ArchiveReader,
    zendeskId: number,
    record: ZendeskTicketRecord,
    context: Context,
  ): Promise<PlannedTicket> {
    const version = await reader.version(String(zendeskId), record.updated_at)
    const fallback = new Date(record.updated_at)
    const planned = [
      ...version.comments.map((comment) =>
        commentMessage(zendeskId, comment, context.users, context.manifest, fallback),
      ),
      ...sideMessages(zendeskId, version.sideConversations, context.manifest, fallback),
    ]
    const attachmentIds = [...new Set(planned.flatMap((item) => item.archived.map((file) => file.id)))]
    const stored = new Map(
      attachmentIds.length === 0
        ? []
        : (
            await this.#db.select().from(messagePart).where(inArray(messagePart.zendeskAttachmentId, attachmentIds))
          ).map((part) => [part.zendeskAttachmentId as string, part]),
    )
    const maxBytes = await this.#files.maxBytes()
    const messages: PlannedTicket["messages"] = []
    for (const item of planned) {
      const fixed = wellFormed({
        text: item.text,
        html: item.html,
        headers: item.headers,
        source: item.source,
        archived: item.archived,
      })
      const images = inlineImages(fixed.value.archived)
      const html = fixed.value.html ? sanitizeMailHtml(fixed.value.html, images.rewrite) : null
      const plain = fixed.value.text ?? (html ? textFromHtml(html) : null)
      const texts: Partial<Record<TextField, string>> = {}
      if (plain) texts.text = plain
      if (html) texts.html = html
      const block = fixed.value.headers.join("\n")
      if (block) texts.headers = block
      const scans = await scanFields(this.#files, texts)
      if (Object.values(scans).some((scan) => scan?.status === "waiting")) throw new ScannerWaitingError()
      const files: PlannedFile[] = []
      for (const [index, file] of fixed.value.archived.entries()) {
        const before = stored.get(file.id) ?? null
        files.push({
          ...file,
          index,
          shown: images.used.has(file.id),
          before,
          decision: await this.#decide(reader, file, before, maxBytes),
        })
      }
      messages.push({
        ...item,
        text: plain,
        html,
        headers: fixed.value.headers,
        source: fixed.value.source,
        files,
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
      files: planned.reduce((sum, item) => sum + item.source.files.length + item.unusable.length, 0),
      links: linksOf(record, version.audits),
      ticketScan,
    }
  }

  async #decide(
    reader: ArchiveReader,
    file: ArchivedFile,
    before: StoredPart | null,
    maxBytes: number,
  ): Promise<FileDecision> {
    if (before && before.sha256 === file.sha256 && before.storedSha256 === file.sha256)
      return { kind: "kept", part: before }
    if (file.bytes > maxBytes) return { kind: "too_large" }
    const bytes = await archivedBytes(reader, file)
    try {
      const outcome = await this.#files.scan(bytes, file.name)
      if (outcome.status === "waiting") throw new ScannerWaitingError()
      return { kind: "scanned", outcome }
    } catch (error) {
      if (error instanceof FileTooLargeError) return { kind: "too_large" }
      throw error
    }
  }

  async #writeFiles(
    tx: Tx,
    reader: ArchiveReader,
    ticketId: string,
    messageId: string,
    files: PlannedFile[],
    headersOk: boolean,
  ): Promise<void> {
    const held = files.map((file) => file.id)
    await tx
      .delete(messagePart)
      .where(
        and(
          eq(messagePart.messageId, messageId),
          held.length > 0
            ? or(isNull(messagePart.zendeskAttachmentId), notInArray(messagePart.zendeskAttachmentId, held))
            : undefined,
        ),
      )
    if (files.length === 0) return
    await tx
      .update(messagePart)
      .set({ index: sql`-1 - ${messagePart.index}` })
      .where(eq(messagePart.messageId, messageId))
    for (const file of files) {
      const fileName = headersOk ? file.name : null
      const place = {
        messageId,
        index: file.index,
        kind: file.inline || file.shown ? "inline" : "attachment",
        fileName,
        declaredType: headersOk ? file.declaredType : null,
        contentId: file.shown ? importedContentId(file.id) : null,
        updatedAt: new Date(),
      }
      const { decision } = file
      let content: Pick<
        StoredPart,
        "size" | "sha256" | "status" | "signature" | "blockedBy" | "storedSha256" | "unavailableReason"
      >
      if (decision.kind === "kept") {
        const { size, sha256, status, signature, blockedBy, storedSha256, unavailableReason } = decision.part
        content = { size, sha256, status, signature, blockedBy, storedSha256, unavailableReason }
      } else if (decision.kind === "too_large") {
        content = {
          size: file.bytes,
          sha256: file.sha256,
          status: "too_large",
          signature: null,
          blockedBy: null,
          storedSha256: null,
          unavailableReason: null,
        }
      } else {
        const { outcome } = decision
        const stored = isStored(outcome.status)
        if (stored) await this.#files.storeIn(tx, await archivedBytes(reader, file), outcome)
        content = {
          size: outcome.size,
          sha256: outcome.sha256,
          status: outcome.status,
          signature: outcome.signature,
          blockedBy: outcome.status === "blocked_type" ? outcome.blockedBy : null,
          storedSha256: stored ? outcome.sha256 : null,
          unavailableReason: null,
        }
      }
      const [part] = await tx
        .insert(messagePart)
        .values({ ...place, ...content, zendeskAttachmentId: file.id })
        .onConflictDoUpdate({ target: messagePart.zendeskAttachmentId, set: { ...place, ...content } })
        .returning({ id: messagePart.id })
      if (decision.kind === "scanned")
        await auditBlockedPart(tx, (file.before?.status ?? null) as ScanOutcome["status"] | null, decision.outcome, {
          ticketId,
          messageId,
          partId: part?.id ?? null,
          fileName,
        })
    }
  }

  async #write(
    reader: ArchiveReader,
    runId: string,
    zendeskId: number,
    record: ZendeskTicketRecord,
    planned: PlannedTicket | null,
    context: Context,
  ): Promise<"written" | "skipped" | "cancelled"> {
    return this.#db.transaction(async (tx) => {
      if (!(await stillRunning(tx, runId))) return "cancelled"
      await lockTicketNumbers(tx)
      await this.#hooks.inTicket?.(zendeskId)
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
      const [received] = existing
        ? await tx
            .select({ id: message.id })
            .from(message)
            .where(and(eq(message.ticketId, existing.id), isNull(message.zendeskKey)))
            .limit(1)
        : []
      const keepLive = received !== undefined

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
        await tx
          .update(ticket)
          .set(keepLive ? { zendesk: columns.zendesk } : columns)
          .where(eq(ticket.id, existing.id))
        ticketId = existing.id
        if (keepLive) reports.push({ reason: "kept_live_changes", detail: null })
      } else {
        const [made] = await tx
          .insert(ticket)
          .values({ ...columns, number: zendeskId, zendeskId, referenceCode: newReferenceCode() })
          .returning({ id: ticket.id })
        if (!made) throw new Error("the ticket was not written")
        ticketId = made.id
      }
      if (!ticketOk && !blockedBefore)
        await writeAudit(tx, SYSTEM, {
          action: "ticket.content_blocked",
          entityType: "ticket",
          entityId: ticketId,
          details: { ticket: zendeskId, reason: planned.ticketScan?.status, signature: planned.ticketScan?.signature },
        })

      if (!keepLive) {
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
      }

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
        if (item.files.some((file) => fileStatus(file) === "too_large")) flags.push("part_too_large")
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
          zendeskMessageId:
            item.source.email.kind === "recorded" ? (messageIds(item.source.email.messageId)[0] ?? null) : null,
        }
        // Without this second pass, a NUL in a sender's or a recipient's name stops the import at its ticket.
        const clean = wellFormed(raw)
        if (clean.changed && !flags.includes("invalid_characters")) flags.push("invalid_characters")
        const values = { ...clean.value, reviewFlags: flags }
        const [row] = await tx
          .insert(message)
          .values({ ...values, zendeskKey: item.key })
          .onConflictDoUpdate({ target: message.zendeskKey, set: values })
          .returning({ id: message.id })
        if (!row) throw new Error("the message was not written")
        await auditBlockedFields(
          tx,
          row.id,
          (before.get(item.key)?.fieldScans ?? {}) as Partial<Record<TextField, FieldScan>>,
          item.scans,
        )
        if (blocked) reports.push({ reason: "blocked_content", detail: item.key })
        await this.#writeFiles(tx, reader, ticketId, row.id, item.files, headersOk)
        const fileDetail = (file: { id: string; name: string | null }) => (headersOk ? (file.name ?? file.id) : file.id)
        for (const file of item.failed) fileReports.push({ reason: "file_failed", detail: fileDetail(file) })
        for (const file of item.unusable)
          fileReports.push({ reason: "file_unusable_id", detail: headersOk ? file.name : null })
        for (const file of item.files) {
          const status = fileStatus(file)
          if (status === "infected") fileReports.push({ reason: "file_infected", detail: fileDetail(file) })
          if (status === "blocked_type") fileReports.push({ reason: "file_blocked", detail: fileDetail(file) })
        }
        if (item.direction === "note") {
          if (item.source.sideConversation) counts.sideConversations = (counts.sideConversations ?? 0) + 1
          else counts.notes = (counts.notes ?? 0) + 1
        } else counts.messages = (counts.messages ?? 0) + 1
      }
      const gone = [...before.keys()].filter((key) => !keys.includes(key))
      if (gone.length > 0) {
        const left = and(eq(message.ticketId, ticketId), inArray(message.zendeskKey, gone))
        await tx
          .delete(messagePart)
          .where(inArray(messagePart.messageId, tx.select({ id: message.id }).from(message).where(left)))
        await tx.delete(message).where(left)
      }

      await flagSameMail(tx, ticketId)

      reports.push(...fileReports)
      counts.tickets = 1
      counts.files = planned.files
      await continueNumbers(tx)
      return done("written")
    })
  }

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

function sameRecorded(run: { archiveRuns: number | null; coveredUntil: Date | null }, mark: ArchiveMark): boolean {
  const covered = mark.coveredUntil ? new Date(mark.coveredUntil).getTime() : null
  return run.archiveRuns === mark.runs && (run.coveredUntil?.getTime() ?? null) === covered
}

async function stillRunning(tx: Tx, runId: string): Promise<boolean> {
  const [row] = await tx.select({ state: importRun.state }).from(importRun).where(eq(importRun.id, runId)).for("update")
  return row?.state === "running"
}

async function addCounts(
  tx: Tx,
  runId: string,
  add: Partial<ImportCounts>,
  set: Partial<ImportCounts> = {},
): Promise<void> {
  const [row] = await tx.select({ counts: importRun.counts }).from(importRun).where(eq(importRun.id, runId))
  const counts = { ...emptyImportCounts(), ...((row?.counts ?? {}) as Partial<ImportCounts>) }
  for (const [key, value] of Object.entries(add) as [keyof ImportCounts, number][]) counts[key] += value
  Object.assign(counts, set)
  await tx.update(importRun).set({ counts }).where(eq(importRun.id, runId))
}

async function continueNumbers(tx: Tx): Promise<void> {
  await tx.execute(sql`
    select setval('ticket_number_seq', greatest(highest, 1), highest > 0)
    from (select greatest(
      (select coalesce(max(${ticket.number}), 0) from ${ticket}),
      (select case when is_called then last_value else last_value - 1 end from ticket_number_seq)
    ) as highest) as numbers`)
}

export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size))
  return out
}

async function archivedBytes(reader: ArchiveReader, file: ArchivedFile): Promise<Buffer> {
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0)
    throw new ArchivedFileError("an archived file's size in the manifest is not a size")
  const root = await realpath(reader.archive.root)
  const path = await realpath(reader.archive.filePath(file.sha256))
  if (!path.startsWith(root + sep)) throw new ArchivedFileError("an archived file leads out of the archive")
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.alloc(file.bytes + 1)
    let length = 0
    while (length < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    const bytes = buffer.subarray(0, length)
    if (length !== file.bytes || sha256Of(bytes) !== file.sha256)
      throw new ArchivedFileError("an archived file does not match its manifest entry")
    return bytes
  } finally {
    await handle.close()
  }
}

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
      current instanceof SyntaxError ||
      current instanceof ArchivedFileError
    )
      return "archive"
    current = facts.cause
  }
  return "other"
}

export async function importJob(importer: ZendeskImport, runId: string): Promise<ImportOutcome> {
  try {
    return await importer.run(runId)
  } catch (error) {
    log.warn("an import run stopped; it goes on from its last ticket", errorFacts(error))
    throw error
  }
}
