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
import { and, eq } from "drizzle-orm"
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
import { recordNotRead } from "./process.ts"
import { wellFormed } from "./text.ts"

export class SourceChangedError extends Error {
  override name = "SourceChangedError"
}

export const isRefusedValue = (error: unknown) => /^(22|54|08P01)/.test(databaseError(error)?.code ?? "")

export const MAX_PAGES_PER_RUN = 100

export interface SyncHooks {
  afterMessages?: (folder: GraphFolder, page: number) => Promise<void>
}

export interface SyncSummary {
  status: "not_configured" | "no_source" | "source_changed" | "done"
  stored: number
  skipped: number
  removed: number
  pages: number
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
    const summary: SyncSummary = { status: "done", stored: 0, skipped: 0, removed: 0, pages: 0 }
    let failure: unknown
    const config = await graphConfig(this.#settings)
    if (!config) return { ...summary, status: "not_configured" }
    const [source] = await this.#db.select().from(intakeSource).where(eq(intakeSource.current, true))
    if (!source || source.tenantId !== config.tenantId.toLowerCase() || source.mailbox !== config.mailbox)
      return { ...summary, status: "no_source" }
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
      for (const item of result.items) {
        if (item["@removed"]) {
          summary.removed++
          continue
        }
        if (await this.#stored(source.id, item.id)) {
          summary.skipped++
          continue
        }
        if (await this.#takeIn(config, source, folder, item)) summary.stored++
        else summary.skipped++
      }
      await hooks.afterMessages?.(folder, page)
      const next = result.nextLink ?? result.deltaLink
      if (!next) throw new Error("Graph answered a delta page without a nextLink or a deltaLink")
      await this.#saveCursor(source.id, folder, next)
      if (!result.nextLink) return
      link = next
    }
  }

  async #stored(sourceId: string, graphId: string): Promise<boolean> {
    const rows = await this.#db
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.sourceId, sourceId), eq(message.graphId, graphId)))
      .limit(1)
    return rows.length > 0
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

  async askAgain(
    config: GraphConfig,
    source: IntakeSource,
    row: Pick<typeof message.$inferSelect, "graph" | "folder" | "receivedAt">,
  ): Promise<boolean> {
    const meta = row.graph as GraphMeta
    const item: DeltaItem = {
      id: meta.id,
      receivedDateTime: row.receivedAt.toISOString(),
      internetMessageId: meta.internetMessageId ?? undefined,
      subject: meta.subject ?? undefined,
      from: meta.from
        ? { emailAddress: { address: meta.from.address ?? undefined, name: meta.from.name ?? undefined } }
        : undefined,
    }
    return this.#takeIn(config, source, row.folder as GraphFolder, item, true)
  }

  async #takeIn(
    config: GraphConfig,
    source: IntakeSource,
    folder: GraphFolder,
    item: DeltaItem,
    again = false,
  ): Promise<boolean> {
    const limit = await this.#settings.get("files.maxBytes")
    const meta = metadataOf(item, folder)
    let fetched: Awaited<ReturnType<GraphGateway["mime"]>>
    try {
      fetched = await this.#graph.mime(config, source.mailbox, item.id, limit)
    } catch (error) {
      if (!mayConcernOneMessage(error)) throw error
      if (!again) return this.#storeRecord(source, folder, item, meta, "not_read", null)
      if (graphStatus(error) !== 404 || !(await this.#graph.test(config)).ok) throw error
      return this.#storeRecord(source, folder, item, meta, "unavailable", null)
    }
    if (fetched.kind === "too_large") return this.#storeRecord(source, folder, item, meta, "too_large", fetched.read)
    let parsed: ParsedMessage
    try {
      parsed = await parseMessage(fetched.bytes)
    } catch {
      return this.#storeRecord(source, folder, item, meta, "unparsed", fetched.bytes.byteLength)
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
      return await this.#storeParsed(source, folder, item, fetched.bytes, parsed, content, fields, raw, parts)
    } catch (error) {
      if (!isRefusedValue(error)) throw error
      log.warn("the database refused a value of a message; it is recorded for review", errorFacts(error))
      return this.#storeRecord(source, folder, item, meta, "unparsed", fetched.bytes.byteLength, "store_failed")
    }
  }

  async #write(tx: Tx, values: typeof message.$inferInsert): Promise<string | undefined> {
    const row = { state: "stored", processedAt: null, retryAt: null, ...values }
    const [written] = await tx
      .insert(message)
      .values(row)
      .onConflictDoUpdate({ target: [message.sourceId, message.graphId], set: row, setWhere: NOT_READ_YET })
      .returning({ id: message.id })
    if (written) await tx.delete(intakeRecord).where(eq(intakeRecord.messageId, written.id))
    return written?.id
  }

  async #storeRecord(
    source: IntakeSource,
    folder: GraphFolder,
    item: DeltaItem,
    meta: GraphMeta,
    content: Exclude<MessageContent, "parsed"> | "not_read",
    size: number | null,
    reason?: MessageFlag,
  ): Promise<boolean> {
    const notRead = content === "not_read"
    const flag: MessageFlag = reason ?? (content === "unparsed" ? "parse_failed" : content)
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
      const id = await this.#write(tx, {
        sourceId: source.id,
        graphId: item.id,
        folder,
        receivedAt: this.#receivedAt(item),
        content: notRead ? "unavailable" : content,
        size,
        ...values,
        fieldScans: fields,
        reviewFlags: flags,
        ...(notRead ? { state: "processed", processedAt: this.#now() } : {}),
      })
      if (id) {
        if (notRead) await recordNotRead(tx, id)
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
      const id = await this.#write(tx, {
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
      })
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
