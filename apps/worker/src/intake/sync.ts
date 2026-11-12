// Stage one of intake (plan 2.3, P5, P13, P21): delta queries on the current source's folders. For each new message:
// fetch its raw MIME within files.maxBytes, parse it, sanitize its HTML, scan the raw message and each part, then
// store, in one transaction that holds the source FOR SHARE and commits only while it is still current, the message,
// its parts, the files that may be kept, and the raw MIME when it and every part scanned clean. Only after a page's
// messages are committed is its nextLink or deltaLink stored, so a crash re-reads the page and skips what is stored
// (unique on source and Graph immutable ID). Nothing here decides about tickets: stage two does (process.ts).

import type { Db } from "@maane/server/db/client"
import { intakeCursor, intakeSource, message, messagePart } from "@maane/server/db/schema"
import { holdSourceIfCurrent, type IntakeSource } from "@maane/server/intake/source"
import { log } from "@maane/server/log"
import type { Settings } from "@maane/server/settings/service"
import {
  GRAPH_FOLDERS,
  type GraphFolder,
  type MessageContent,
  type MessageFlag,
  type PartStatus,
  STORED_STATUSES,
  type StoredStatus,
} from "@maane/shared"
import { and, eq } from "drizzle-orm"
import { auditBlockedPart, type FileService, FileTooLargeError, type ScanOutcome, sha256Of } from "../files/service.ts"
import type { Tx } from "../files/types.ts"
import {
  type DeltaItem,
  type GraphConfig,
  type GraphGateway,
  graphConfig,
  graphStatus,
  isExpiredDelta,
} from "./graph.ts"
import { type MailPart, type ParsedMessage, parseMessage } from "./parse.ts"
import { wellFormed } from "./text.ts"

/** The current source changed while this round ran: what it fetched since is discarded, and the job stops. */
export class SourceChangedError extends Error {
  override name = "SourceChangedError"
}

/** The pages one folder may take in one run; the cursor keeps the place for the next run. */
export const MAX_PAGES_PER_RUN = 100

export interface SyncHooks {
  /** After a page's messages are committed, before its link is stored: a test makes the worker "crash" here. */
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

/** Graph's metadata of a message, as the record keeps it. */
function metadataOf(item: DeltaItem, folder: GraphFolder) {
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

  /** One round over both folders of the current source. Throws on a temporary Graph failure; the cursor stays. */
  async run(hooks: SyncHooks = {}, maxPages = MAX_PAGES_PER_RUN): Promise<SyncSummary> {
    const summary: SyncSummary = { status: "done", stored: 0, skipped: 0, removed: 0, pages: 0 }
    const config = await graphConfig(this.#settings)
    if (!config) return { ...summary, status: "not_configured" }
    const [source] = await this.#db.select().from(intakeSource).where(eq(intakeSource.current, true))
    if (!source || source.tenantId !== config.tenantId.toLowerCase() || source.mailbox !== config.mailbox)
      return { ...summary, status: "no_source" }
    try {
      for (const folder of GRAPH_FOLDERS) await this.#folder(config, source, folder, summary, hooks, maxPages)
    } catch (error) {
      if (error instanceof SourceChangedError) {
        log.info("the intake source changed during a sync round; the round stopped", { stored: summary.stored })
        return { ...summary, status: "source_changed" }
      }
      throw error
    }
    if (summary.stored > 0) log.info("intake stored new messages", { stored: summary.stored })
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
        // The delta token expired: a full sync of the folder, skipping what is stored (requirements 2.1).
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
        // A vanished item (P5): never stored, nothing to do; already stored, Maane keeps what it stored.
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
      await this.#saveCursor(source.id, folder, next, result.nextLink ? "next" : "delta")
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

  async #saveCursor(sourceId: string, folder: GraphFolder, link: string, kind: "next" | "delta"): Promise<void> {
    await this.#db.transaction(async (tx) => {
      if (!(await holdSourceIfCurrent(tx, sourceId))) throw new SourceChangedError()
      await tx
        .insert(intakeCursor)
        .values({ sourceId, folder, link, kind })
        .onConflictDoUpdate({
          target: [intakeCursor.sourceId, intakeCursor.folder],
          set: { link, kind, updatedAt: this.#now() },
        })
    })
  }

  /** Fetches, parses, scans, and stores one message. Returns false when it was already stored meanwhile. */
  async #takeIn(config: GraphConfig, source: IntakeSource, folder: GraphFolder, item: DeltaItem): Promise<boolean> {
    const limit = await this.#settings.get("files.maxBytes")
    const meta = metadataOf(item, folder)
    let fetched: Awaited<ReturnType<GraphGateway["mime"]>>
    try {
      fetched = await this.#graph.mime(config, source.mailbox, item.id, limit)
    } catch (error) {
      // A 404 is final (P5): the item is recorded with its Graph metadata, and the cursor moves on.
      if (graphStatus(error) === 404) return this.#storeRecord(source, folder, item, meta, "unavailable", null)
      throw error
    }
    if (fetched.kind === "too_large") return this.#storeRecord(source, folder, item, meta, "too_large", fetched.read)
    let parsed: ParsedMessage
    try {
      parsed = await parseMessage(fetched.bytes)
    } catch {
      return this.#storeRecord(source, folder, item, meta, "unparsed", fetched.bytes.byteLength)
    }
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
    return this.#storeParsed(source, folder, item, meta, fetched.bytes, parsed, raw, parts)
  }

  /** A message stage one could not read in full: only Graph's metadata, flagged for review. */
  async #storeRecord(
    source: IntakeSource,
    folder: GraphFolder,
    item: DeltaItem,
    meta: ReturnType<typeof metadataOf>,
    content: Exclude<MessageContent, "parsed">,
    size: number | null,
  ): Promise<boolean> {
    const flag: MessageFlag = content === "unparsed" ? "parse_failed" : content
    const fixed = wellFormed({
      graph: meta,
      subject: meta.subject,
      fromAddress: meta.from?.address?.toLowerCase() ?? null,
      fromName: meta.from?.name ?? null,
    })
    const flags: MessageFlag[] = fixed.changed ? [flag, "invalid_characters"] : [flag]
    return this.#db.transaction(async (tx) => {
      if (!(await holdSourceIfCurrent(tx, source.id))) throw new SourceChangedError()
      const [row] = await tx
        .insert(message)
        .values({
          sourceId: source.id,
          graphId: item.id,
          folder,
          receivedAt: this.#receivedAt(item),
          content,
          size,
          ...fixed.value,
          reviewFlags: flags,
        })
        .onConflictDoNothing({ target: [message.sourceId, message.graphId] })
        .returning({ id: message.id })
      if (row) log.warn("a message was recorded for review without its content", { reason: flag })
      return row !== undefined
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
    meta: ReturnType<typeof metadataOf>,
    raw: Buffer,
    parsed: ParsedMessage,
    rawScan: ScanOutcome,
    parts: PartScan[],
  ): Promise<boolean> {
    // Every string headed for the database, made well formed in one place (P21).
    const fixed = wellFormed({
      graph: meta,
      messageIdHeader: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      fromAddress: parsed.from?.address ?? null,
      fromName: parsed.from?.name ?? null,
      toAddresses: parsed.to,
      ccAddresses: parsed.cc,
      subject: parsed.subject,
      headers: parsed.headers,
      textBody: parsed.text,
      htmlBody: parsed.html,
      reportOriginalMessageId: parsed.reportOriginalMessageId,
      parts: parts.map(({ part }) => ({
        fileName: part.fileName,
        declaredType: part.declaredType,
        contentId: part.contentId,
      })),
    })
    const { parts: partText, ...row } = fixed.value
    const flags: MessageFlag[] = []
    if (fixed.changed) flags.push("invalid_characters")
    if (parts.some((scan) => "tooLarge" in scan)) flags.push("part_too_large")
    const everyPartClean = parts.every((scan) => "outcome" in scan && scan.outcome.status === "clean")
    const keepRaw = rawScan.status === "clean" && everyPartClean

    return this.#db.transaction(async (tx) => {
      if (!(await holdSourceIfCurrent(tx, source.id))) throw new SourceChangedError()
      const [stored] = await tx
        .insert(message)
        .values({
          sourceId: source.id,
          graphId: item.id,
          folder,
          receivedAt: this.#receivedAt(item),
          content: "parsed",
          size: raw.byteLength,
          ...row,
          sentAt: parsed.date,
          contentHash: parsed.contentHash,
          rawStatus: rawScan.status,
          reviewFlags: flags,
        })
        .onConflictDoNothing({ target: [message.sourceId, message.graphId] })
        .returning({ id: message.id })
      if (!stored) return false
      for (const [position, scan] of parts.entries()) {
        await this.#storePart(tx, stored.id, scan, partText[position] ?? null)
      }
      if (keepRaw) {
        await this.#files.storeIn(tx, raw, rawScan)
        await tx.update(message).set({ rawSha256: rawScan.sha256 }).where(eq(message.id, stored.id))
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
