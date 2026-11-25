import type { Db } from "@maane/server/db/client"
import { intakeCursor, intakeRecord, intakeSource, message, messagePart } from "@maane/server/db/schema"
import { holdSourceIfCurrent, type IntakeSource } from "@maane/server/intake/source"
import { errorFacts, log } from "@maane/server/log"
import { databaseError } from "@maane/server/organizations/refusal"
import type { Settings } from "@maane/server/settings/service"
import {
  type FieldScan,
  GRAPH_FOLDERS,
  type GraphFolder,
  type MessageContent,
  type MessageFlag,
  type PartStatus,
  STORED_STATUSES,
  type StoredStatus,
  type TextField,
} from "@maane/shared"
import { and, asc, desc, eq, lte, sql } from "drizzle-orm"
import { auditBlockedPart, type FileService, FileTooLargeError, type ScanOutcome, sha256Of } from "../files/service.ts"
import type { Tx } from "../files/types.ts"
import {
  auditBlockedFields,
  columnsOf,
  contentOf,
  fieldTexts,
  type GraphMeta,
  NOT_READ_YET,
  partNamesOf,
  refused,
  type MessageContent as StoredContent,
  scanFields,
  storable,
} from "./content.ts"
import {
  type DeltaItem,
  type GraphConfig,
  type GraphGateway,
  graphConfig,
  graphStatus,
  isExpiredDelta,
  mayConcernOneMessage,
} from "./graph.ts"
import { type MailPart, type ParsedMessage, parseMessage } from "./parse.ts"
import { recordGone, recordNotRead } from "./process.ts"
import { wellFormed } from "./text.ts"

export class SourceChangedError extends Error {
  override name = "SourceChangedError"
}

class NotHandedOverError extends Error {
  override name = "NotHandedOverError"
  constructor(readonly answer: unknown) {
    super("not_handed_over")
  }
}

export const isRefusedValue = (error: unknown) => /^(22|54|08P01)/.test(databaseError(error)?.code ?? "")

export const MAX_PAGES_PER_RUN = 100
export const MAX_ASKED_AGAIN_PER_RUN = 50
const MAX_CONTROLS = 20

export interface SyncHooks {
  afterMessages?: (folder: GraphFolder, page: number) => Promise<void>
}

export interface SyncSummary {
  status: "not_configured" | "no_source" | "source_changed" | "done"
  stored: number
  skipped: number
  removed: number
  pages: number
  notRead: number
}

export interface AskAgainSummary {
  asked: number
  read: number
  gone: number
}

export interface IntakeOptions {
  db: Db
  settings: Settings
  files: FileService
  graph: GraphGateway
  now?: () => Date
}

type PartScan =
  | { part: MailPart; outcome: ScanOutcome }
  | { part: MailPart; tooLarge: { sha256: string; size: number } }

const isStored = (status: PartStatus): status is StoredStatus => (STORED_STATUSES as readonly string[]).includes(status)

function metadataOf(item: DeltaItem, folder: GraphFolder): GraphMeta {
  return {
    id: item.id,
    folder,
    receivedDateTime: item.receivedDateTime ?? null,
    internetMessageId: item.internetMessageId ?? null,
    subject: item.subject ?? null,
    from: item.from?.emailAddress
      ? { address: item.from.emailAddress.address ?? null, name: item.from.emailAddress.name ?? null }
      : null,
  }
}

export class IntakeSync {
  readonly #db: Db
  readonly #settings: Settings
  readonly #files: FileService
  readonly #graph: GraphGateway
  readonly #now: () => Date

  constructor(options: IntakeOptions) {
    this.#db = options.db
    this.#settings = options.settings
    this.#files = options.files
    this.#graph = options.graph
    this.#now = options.now ?? (() => new Date())
  }

  async run(hooks: SyncHooks = {}, maxPages = MAX_PAGES_PER_RUN): Promise<SyncSummary> {
    const summary: SyncSummary = { status: "done", stored: 0, skipped: 0, removed: 0, pages: 0, notRead: 0 }
    let failure: unknown
    const config = await graphConfig(this.#settings)
    if (!config) return { ...summary, status: "not_configured" }
    const source = await this.#source(config)
    if (!source) return { ...summary, status: "no_source" }
    for (const folder of GRAPH_FOLDERS) {
      try {
        await this.#folder(config, source, folder, summary, hooks, maxPages)
      } catch (error) {
        if (error instanceof SourceChangedError) {
          log.info("the intake source changed during a sync round; the round stopped", { stored: summary.stored })
          return { ...summary, status: "source_changed" }
        }
        log.warn("reading a folder failed; the next round starts at its cursor again", {
          folder,
          ...errorFacts(error),
        })
        failure ??= error
      }
    }
    if (summary.stored > 0) log.info("intake stored new messages", { stored: summary.stored })
    if (failure) throw failure
    return summary
  }

  async #source(config: GraphConfig): Promise<IntakeSource | null> {
    const [source] = await this.#db.select().from(intakeSource).where(eq(intakeSource.current, true))
    return source && source.tenantId === config.tenantId.toLowerCase() && source.mailbox === config.mailbox
      ? source
      : null
  }

  async #folder(
    config: GraphConfig,
    source: IntakeSource,
    folder: GraphFolder,
    summary: SyncSummary,
    hooks: SyncHooks,
    maxPages: number,
  ): Promise<void> {
    const [cursor] = await this.#db
      .select()
      .from(intakeCursor)
      .where(and(eq(intakeCursor.sourceId, source.id), eq(intakeCursor.folder, folder)))
    const first = this.#graph.firstDeltaLink(config, folder)
    let link = cursor?.link ?? first
    let restarted = false
    for (let page = 1; page <= maxPages; page++) {
      let result: Awaited<ReturnType<GraphGateway["delta"]>>
      try {
        result = await this.#graph.delta(config, link)
      } catch (error) {
        if (isExpiredDelta(error) && !restarted && link !== first) {
          log.warn("the delta token expired; a full sync of the folder follows", { folder })
          restarted = true
          link = first
          page--
          continue
        }
        throw error
      }
      summary.pages++
      const refused: { item: DeltaItem; answer: unknown }[] = []
      for (const item of result.items) {
        if (item["@removed"]) {
          summary.removed++
          continue
        }
        const existing = await this.#existing(source.id, item.id)
        if (existing) {
          if (existing.content === "unavailable") await this.#listedAgain(source, item.id)
          summary.skipped++
          continue
        }
        try {
          if (await this.#takeIn(config, source, folder, item)) summary.stored++
          else summary.skipped++
        } catch (error) {
          if (!(error instanceof NotHandedOverError)) throw error
          refused.push({ item, answer: error.answer })
        }
      }
      for (const { item, answer } of refused) {
        if (!(await this.#handsOver(config, source))) throw answer
        try {
          if (await this.#takeIn(config, source, folder, item)) summary.stored++
          else summary.skipped++
        } catch (error) {
          if (!(error instanceof NotHandedOverError)) throw error
          await this.#storeRecord(source, folder, item, metadataOf(item, folder), "not_read", null)
          summary.notRead++
        }
      }
      await hooks.afterMessages?.(folder, page)
      const next = result.nextLink ?? result.deltaLink
      if (!next) throw new Error("Graph answered a delta page without a nextLink or a deltaLink")
      await this.#saveCursor(source.id, folder, next)
      if (!result.nextLink) return
      link = next
    }
  }

  async #existing(sourceId: string, graphId: string): Promise<{ content: string } | undefined> {
    const [row] = await this.#db
      .select({ content: message.content })
      .from(message)
      .where(and(eq(message.sourceId, sourceId), eq(message.graphId, graphId)))
      .limit(1)
    return row
  }

  async #handsOver(config: GraphConfig, source: IntakeSource): Promise<boolean> {
    const limit = await this.#settings.get("files.maxBytes")
    const controls = await this.#db
      .select({ graphId: message.graphId })
      .from(message)
      .where(and(eq(message.sourceId, source.id), eq(message.content, "parsed"), lte(message.size, limit)))
      .orderBy(desc(message.receivedAt))
      .limit(MAX_CONTROLS)
    for (const { graphId } of controls) {
      if (graphId === null) continue
      try {
        const fetched = await this.#graph.mime(config, source.mailbox, graphId, limit)
        if (fetched.kind === "ok") return true
      } catch (error) {
        if (!mayConcernOneMessage(error)) return false
      }
    }
    return false
  }

  async #listedAgain(source: IntakeSource, graphId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      if (!(await holdSourceIfCurrent(tx, source.id))) throw new SourceChangedError()
      const [row] = await tx
        .update(message)
        .set({ retryAt: null })
        .where(and(eq(message.sourceId, source.id), eq(message.graphId, graphId), eq(message.content, "unavailable")))
        .returning({ id: message.id })
      if (row) await this.#waits(tx, row.id)
    })
  }

  async #waits(tx: Tx, id: string): Promise<void> {
    await tx
      .update(message)
      .set({
        state: "processed",
        processedAt: this.#now(),
        reviewFlags: sql`array_append(array_remove(array_remove(${message.reviewFlags}, 'unavailable'), 'not_read'), 'not_read')`,
      })
      .where(eq(message.id, id))
    await recordNotRead(tx, id)
  }

  async #gone(source: IntakeSource, id: string, askedAt: Date): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      if (!(await holdSourceIfCurrent(tx, source.id))) throw new SourceChangedError()
      const [row] = await tx
        .update(message)
        .set({ reviewFlags: sql`array_replace(${message.reviewFlags}, 'not_read', 'unavailable')` })
        .where(and(eq(message.id, id), NOT_READ_YET, eq(message.retryAt, askedAt)))
        .returning({ id: message.id })
      if (row) await recordGone(tx, id)
      return row !== undefined
    })
  }

  async askAgain(limit = MAX_ASKED_AGAIN_PER_RUN): Promise<AskAgainSummary> {
    const summary: AskAgainSummary = { asked: 0, read: 0, gone: 0 }
    const config = await graphConfig(this.#settings)
    const source = config ? await this.#source(config) : null
    if (!config || !source) return summary
    const rows = await this.#db
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.sourceId, source.id), NOT_READ_YET))
      .orderBy(sql`${message.retryAt} asc nulls first`, asc(message.receivedAt))
      .limit(limit)
    if (rows.length === 0) return summary
    const folders = await this.#graph.folders(config)
    for (const { id } of rows) {
      const askedAt = this.#now()
      const [row] = await this.#db
        .update(message)
        .set({ retryAt: askedAt })
        .where(and(eq(message.id, id), NOT_READ_YET))
        .returning({ graphId: message.graphId })
      if (!row?.graphId) continue
      summary.asked++
      try {
        const item = await this.#lookUp(config, source, row.graphId)
        const folder = item && folders.get(item.parentFolderId ?? "")
        if (!item || !folder) {
          if (await this.#gone(source, id, askedAt)) summary.gone++
        } else if (await this.#takeIn(config, source, folder, item, id)) summary.read++
      } catch (error) {
        if (error instanceof SourceChangedError) return summary
        if (!(error instanceof NotHandedOverError)) throw error
        log.warn("Graph still does not hand over a message; it stays not read yet", errorFacts(error.answer))
      }
    }
    return summary
  }

  async #lookUp(config: GraphConfig, source: IntakeSource, graphId: string): Promise<DeltaItem | null> {
    try {
      return await this.#graph.metadata(config, source.mailbox, graphId)
    } catch (error) {
      if (graphStatus(error) !== 404) throw mayConcernOneMessage(error) ? new NotHandedOverError(error) : error
      if ((await this.#graph.test(config)).ok) return null
      throw error
    }
  }

  async #saveCursor(sourceId: string, folder: GraphFolder, link: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      if (!(await holdSourceIfCurrent(tx, sourceId))) throw new SourceChangedError()
      await tx
        .insert(intakeCursor)
        .values({ sourceId, folder, link })
        .onConflictDoUpdate({
          target: [intakeCursor.sourceId, intakeCursor.folder],
          set: { link, updatedAt: this.#now() },
        })
    })
  }

  async #takeIn(
    config: GraphConfig,
    source: IntakeSource,
    folder: GraphFolder,
    item: DeltaItem,
    waitingId?: string,
  ): Promise<boolean> {
    const limit = await this.#settings.get("files.maxBytes")
    const meta = metadataOf(item, folder)
    let fetched: Awaited<ReturnType<GraphGateway["mime"]>>
    try {
      fetched = await this.#graph.mime(config, source.mailbox, item.id, limit)
    } catch (error) {
      if (graphStatus(error) === 404 && !waitingId && (await this.#lookUp(config, source, item.id)) === null)
        return this.#storeRecord(source, folder, item, meta, "unavailable", null)
      throw mayConcernOneMessage(error) ? new NotHandedOverError(error) : error
    }
    if (fetched.kind === "too_large")
      return this.#storeRecord(source, folder, item, meta, "too_large", fetched.read, { waitingId })
    let parsed: ParsedMessage
    try {
      parsed = await parseMessage(fetched.bytes)
    } catch {
      return this.#storeRecord(source, folder, item, meta, "unparsed", fetched.bytes.byteLength, { waitingId })
    }
    const content = contentOf(parsed, meta)
    const fields = await scanFields(this.#files, fieldTexts(content))
    const raw = await this.#files.scan(fetched.bytes, null)
    const parts: PartScan[] = []
    for (const part of parsed.parts) {
      try {
        parts.push({ part, outcome: await this.#files.scan(part.content, part.fileName) })
      } catch (error) {
        if (!(error instanceof FileTooLargeError)) throw error
        parts.push({ part, tooLarge: { sha256: sha256Of(part.content), size: part.content.byteLength } })
      }
    }
    try {
      return await this.#storeParsed(
        source,
        folder,
        item,
        fetched.bytes,
        parsed,
        content,
        fields,
        raw,
        parts,
        waitingId,
      )
    } catch (error) {
      if (!isRefusedValue(error)) throw error
      log.warn("the database refused a value of a message; it is recorded for review", errorFacts(error))
      return this.#storeRecord(source, folder, item, meta, "unparsed", fetched.bytes.byteLength, {
        waitingId,
        flag: "store_failed",
      })
    }
  }

  async #write(tx: Tx, values: typeof message.$inferInsert, waitingId?: string): Promise<string | undefined> {
    if (!waitingId) {
      const [stored] = await tx
        .insert(message)
        .values(values)
        .onConflictDoNothing({ target: [message.sourceId, message.graphId] })
        .returning({ id: message.id })
      return stored?.id
    }
    const [read] = await tx
      .update(message)
      .set({ ...values, state: "stored", processedAt: null, retryAt: null })
      .where(and(eq(message.id, waitingId), NOT_READ_YET))
      .returning({ id: message.id })
    if (read) await tx.delete(intakeRecord).where(eq(intakeRecord.messageId, read.id))
    return read?.id
  }

  async #storeRecord(
    source: IntakeSource,
    folder: GraphFolder,
    item: DeltaItem,
    meta: GraphMeta,
    reason: Exclude<MessageContent, "parsed"> | "not_read",
    size: number | null,
    options: { waitingId?: string; flag?: MessageFlag } = {},
  ): Promise<boolean> {
    const content = reason === "not_read" ? "unavailable" : reason
    const flag: MessageFlag = options.flag ?? (reason === "unparsed" ? "parse_failed" : reason)
    const fixed = wellFormed({
      graph: {
        ...meta,
        internetMessageId: meta.internetMessageId?.slice(0, 1000) ?? null,
        from: meta.from ? { address: meta.from.address?.slice(0, 254) ?? null, name: meta.from.name } : null,
      },
      subject: meta.subject,
      fromAddress: meta.from?.address?.toLowerCase().slice(0, 254) ?? null,
      fromName: meta.from?.name ?? null,
    })
    const block = [fixed.value.subject, fixed.value.fromName].filter(Boolean).join("\n")
    const fields = block ? await scanFields(this.#files, { headers: block }) : {}
    const ok = storable(fields.headers)
    const flags: MessageFlag[] = [flag]
    if (fixed.changed) flags.push("invalid_characters")
    if (refused(fields.headers)) flags.push("blocked_content")
    const values = ok
      ? fixed.value
      : {
          ...fixed.value,
          subject: null,
          fromName: null,
          graph: {
            ...fixed.value.graph,
            subject: null,
            from: fixed.value.graph.from ? { ...fixed.value.graph.from, name: null } : null,
          },
        }
    return this.#db.transaction(async (tx) => {
      if (!(await holdSourceIfCurrent(tx, source.id))) throw new SourceChangedError()
      const id = await this.#write(
        tx,
        {
          sourceId: source.id,
          graphId: item.id,
          folder,
          receivedAt: this.#receivedAt(item),
          content,
          size,
          ...values,
          fieldScans: fields,
          reviewFlags: flags,
        },
        options.waitingId,
      )
      if (id) {
        if (reason === "not_read") await this.#waits(tx, id)
        await auditBlockedFields(tx, id, {}, fields)
        log.warn("a message was recorded for review without its content", { reason: flag })
      }
      return id !== undefined
    })
  }

  #receivedAt(item: DeltaItem): Date {
    const at = item.receivedDateTime ? new Date(item.receivedDateTime) : null
    return at && !Number.isNaN(at.getTime()) ? at : this.#now()
  }

  async #storeParsed(
    source: IntakeSource,
    folder: GraphFolder,
    item: DeltaItem,
    raw: Buffer,
    parsed: ParsedMessage,
    content: StoredContent,
    fields: Partial<Record<TextField, FieldScan>>,
    rawScan: ScanOutcome,
    parts: PartScan[],
    waitingId?: string,
  ): Promise<boolean> {
    const columns = columnsOf(content, fields)
    const names = partNamesOf(content, fields)
    const flags: MessageFlag[] = []
    if (content.invalidCharacters) flags.push("invalid_characters")
    if (parts.some((scan) => "tooLarge" in scan)) flags.push("part_too_large")
    if (Object.values(fields).some((scan) => refused(scan))) flags.push("blocked_content")
    const everyPartClean = parts.every((scan) => "outcome" in scan && scan.outcome.status === "clean")
    const keepRaw =
      rawScan.status === "clean" && everyPartClean && Object.values(fields).every((scan) => scan?.status === "clean")

    return this.#db.transaction(async (tx) => {
      if (!(await holdSourceIfCurrent(tx, source.id))) throw new SourceChangedError()
      const id = await this.#write(
        tx,
        {
          sourceId: source.id,
          graphId: item.id,
          folder,
          receivedAt: this.#receivedAt(item),
          content: "parsed",
          size: raw.byteLength,
          ...columns,
          contentHash: parsed.contentHash,
          rawStatus: rawScan.status,
          reviewFlags: flags,
        },
        waitingId,
      )
      if (!id) return false
      await auditBlockedFields(tx, id, {}, fields)
      for (const [position, scan] of parts.entries()) {
        await this.#storePart(tx, id, scan, names[position] ?? null)
      }
      if (keepRaw) {
        await this.#files.storeIn(tx, raw, rawScan)
        await tx.update(message).set({ rawSha256: rawScan.sha256 }).where(eq(message.id, id))
      }
      return true
    })
  }

  async #storePart(
    tx: Tx,
    messageId: string,
    scan: PartScan,
    text: { fileName: string | null; declaredType: string | null; contentId: string | null } | null,
  ): Promise<void> {
    const { part } = scan
    const names = text ?? { fileName: null, declaredType: null, contentId: null }
    if ("tooLarge" in scan) {
      await tx.insert(messagePart).values({
        messageId,
        index: part.index,
        kind: part.kind,
        ...names,
        size: scan.tooLarge.size,
        sha256: scan.tooLarge.sha256,
        status: "too_large",
      })
      return
    }
    const { outcome } = scan
    const status = outcome.status as PartStatus
    if (isStored(status)) await this.#files.storeIn(tx, part.content, outcome)
    const [row] = await tx
      .insert(messagePart)
      .values({
        messageId,
        index: part.index,
        kind: part.kind,
        ...names,
        size: outcome.size,
        sha256: outcome.sha256,
        status,
        signature: outcome.signature,
        blockedBy: outcome.status === "blocked_type" ? outcome.blockedBy : null,
        storedSha256: isStored(status) ? outcome.sha256 : null,
      })
      .returning({ id: messagePart.id })
    await auditBlockedPart(tx, null, outcome, {
      ticketId: null,
      messageId,
      partId: row?.id ?? null,
      fileName: names.fileName,
    })
  }
}
