// What waits for the scanner (plan 2.3, P5, P13; review G1, G6, G7): while files, text fields, or a raw message wait,
// this job fetches their messages again from Graph, by the message's own source (its mailbox) and immutable ID with the
// credential in effect now, and scans what waits again. Finishing what was already taken in is not tied to the current
// source. A 401, 403, or 404 (the message, or access to its old mailbox, is gone) makes what waits `unavailable` with
// that status as its reason, so nothing waits for ever; any other failure leaves it waiting. The raw MIME is kept once
// it, every part, and every text field scanned clean, also when they were decided after the raw message. Each run takes the messages
// tried longest ago first, so messages that keep failing cannot starve the others.

import type { Db } from "@maane/server/db/client"
import { intakeSource, message, messagePart } from "@maane/server/db/schema"
import { errorFacts, log } from "@maane/server/log"
import type { Settings } from "@maane/server/settings/service"
import { type FieldScan, type PartStatus, STORED_STATUSES, type StoredStatus, type TextField } from "@maane/shared"
import { and, asc, eq, exists, or, sql } from "drizzle-orm"
import { auditBlockedPart, type FileService, FileTooLargeError, type ScanOutcome, sha256Of } from "../files/service.ts"
import {
  auditBlockedFields,
  columnsOf,
  contentOf,
  fieldTexts,
  type GraphMeta,
  partNamesOf,
  refused,
  scanFields,
  storable,
} from "./content.ts"
import { type DeltaItem, type GraphConfig, type GraphGateway, graphConfig, graphStatus, isGone } from "./graph.ts"
import { type ParsedMessage, parseMessage } from "./parse.ts"
import { wellFormed } from "./text.ts"

/** The most messages one run fetches again. */
export const MAX_RETRIES_PER_RUN = 50

const isStored = (status: PartStatus): status is StoredStatus => (STORED_STATUSES as readonly string[]).includes(status)

export interface RetrySummary {
  messages: number
  decided: number
  unavailable: number
  stillWaiting: number
}

type Scans = Partial<Record<TextField, FieldScan>>

const waitingFields = (scans: Scans) =>
  (Object.entries(scans) as [TextField, FieldScan][]).filter(([, scan]) => scan?.status === "waiting").map(([f]) => f)

export class WaitingFiles {
  readonly #db: Db
  readonly #settings: Settings
  readonly #files: FileService
  readonly #graph: GraphGateway
  readonly #now: () => Date

  constructor(options: { db: Db; settings: Settings; files: FileService; graph: GraphGateway; now?: () => Date }) {
    this.#db = options.db
    this.#settings = options.settings
    this.#files = options.files
    this.#graph = options.graph
    this.#now = options.now ?? (() => new Date())
  }

  async run(limit = MAX_RETRIES_PER_RUN): Promise<RetrySummary> {
    const summary: RetrySummary = { messages: 0, decided: 0, unavailable: 0, stillWaiting: 0 }
    const waiting = await this.#db
      .select({ id: message.id, graphId: message.graphId, mailbox: intakeSource.mailbox, content: message.content })
      .from(message)
      .innerJoin(intakeSource, eq(intakeSource.id, message.sourceId))
      .where(
        or(
          eq(message.rawStatus, "waiting"),
          sql`jsonb_path_exists(${message.fieldScans}, '$.* ? (@.status == "waiting")')`,
          exists(
            this.#db
              .select({ id: messagePart.id })
              .from(messagePart)
              .where(and(eq(messagePart.messageId, message.id), eq(messagePart.status, "waiting"))),
          ),
        ),
      )
      // Tried longest ago first (never tried first), then the oldest mail.
      .orderBy(sql`${message.retryAt} asc nulls first`, asc(message.receivedAt))
      .limit(limit)
    if (waiting.length === 0) return summary
    const config = await graphConfig(this.#settings)
    if (!config) return { ...summary, stillWaiting: waiting.length }
    const maxBytes = await this.#settings.get("files.maxBytes")
    for (const item of waiting) {
      summary.messages++
      await this.#db
        .update(message)
        .set({ retryAttempts: sql`${message.retryAttempts} + 1`, retryAt: this.#now() })
        .where(eq(message.id, item.id))
      // A record kept only Graph's metadata: its header values come from that metadata, fetched again (review G14).
      if (item.content !== "parsed") {
        const result = await this.#retryRecord(config, item)
        if (result === "waiting") summary.stillWaiting++
        else if (result === "unavailable") summary.unavailable++
        else summary.decided++
        continue
      }
      let bytes: Buffer | null = null
      let gone: string | null = null
      try {
        const fetched = await this.#graph.mime(config, item.mailbox, item.graphId, maxBytes)
        if (fetched.kind === "too_large") gone = "too_large"
        else bytes = fetched.bytes
      } catch (error) {
        const status = graphStatus(error)
        if (isGone(status)) gone = `graph_${status}`
        else {
          log.warn(
            "fetching a message again for what waits for the scanner failed; it keeps waiting",
            errorFacts(error),
          )
          summary.stillWaiting++
          continue
        }
      }
      let parsed: ParsedMessage | null = null
      if (bytes) parsed = await parseMessage(bytes).catch(() => null)
      if (!bytes || !parsed) {
        await this.#unavailable(item.id, gone ?? "parse_failed")
        summary.unavailable++
        continue
      }
      const result = await this.#rescan(item.id, bytes, parsed)
      if (result === "waiting") summary.stillWaiting++
      else summary.decided++
    }
    return summary
  }

  /** A record's header values (Graph's subject and sender name) fetched again and scanned. */
  async #retryRecord(
    config: GraphConfig,
    item: { id: string; graphId: string; mailbox: string },
  ): Promise<"waiting" | "decided" | "unavailable"> {
    let meta: DeltaItem
    try {
      meta = await this.#graph.metadata(config, item.mailbox, item.graphId)
    } catch (error) {
      const status = graphStatus(error)
      if (isGone(status)) {
        await this.#unavailable(item.id, `graph_${status}`)
        return "unavailable"
      }
      log.warn("fetching a record's metadata again failed; it keeps waiting", errorFacts(error))
      return "waiting"
    }
    const fixed = wellFormed({ subject: meta.subject ?? null, name: meta.from?.emailAddress?.name ?? null })
    const block = [fixed.value.subject, fixed.value.name].filter(Boolean).join("\n")
    const scan = block ? (await scanFields(this.#files, { headers: block })).headers : undefined
    if (scan?.status === "waiting") return "waiting"
    await this.#db.transaction(async (tx) => {
      const [locked] = await tx.select().from(message).where(eq(message.id, item.id)).for("update")
      const before = (locked?.fieldScans ?? {}) as Scans
      if (!locked || before.headers?.status !== "waiting") return
      const decided: FieldScan = scan ?? { status: "clean", signature: null, blockedBy: null }
      const scans: Scans = { ...before, headers: decided }
      const graph = (locked.graph ?? {}) as Record<string, unknown> & { from?: Record<string, unknown> | null }
      const ok = storable(decided)
      await tx
        .update(message)
        .set({
          fieldScans: scans,
          ...(ok
            ? {
                subject: fixed.value.subject,
                fromName: fixed.value.name,
                graph: {
                  ...graph,
                  subject: fixed.value.subject,
                  from: { ...(graph.from ?? {}), name: fixed.value.name },
                },
              }
            : {}),
          ...(refused(decided) ? { reviewFlags: [...new Set([...locked.reviewFlags, "blocked_content"])] } : {}),
        })
        .where(eq(message.id, item.id))
      await auditBlockedFields(tx, item.id, before, scans)
    })
    return "decided"
  }

  /** What waits on a message becomes unavailable, with the reason. Its text fields then stay unstored. */
  async #unavailable(messageId: string, reason: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select({ fieldScans: message.fieldScans })
        .from(message)
        .where(eq(message.id, messageId))
        .for("update")
      await tx
        .update(messagePart)
        .set({ status: "unavailable", unavailableReason: reason, updatedAt: this.#now() })
        .where(and(eq(messagePart.messageId, messageId), eq(messagePart.status, "waiting")))
      const scans = { ...((row?.fieldScans ?? {}) as Scans) }
      for (const field of waitingFields(scans))
        scans[field] = { status: "unavailable", signature: null, blockedBy: null }
      await tx.update(message).set({ fieldScans: scans }).where(eq(message.id, messageId))
      await tx
        .update(message)
        .set({ rawStatus: "unavailable" })
        .where(and(eq(message.id, messageId), eq(message.rawStatus, "waiting")))
    })
    log.info("what waited for the scanner became unavailable", { reason })
  }

  /** Scans again what waits; returns whether anything still waits. */
  async #rescan(messageId: string, raw: Buffer, parsed: ParsedMessage): Promise<"waiting" | "decided"> {
    const [current] = await this.#db.select().from(message).where(eq(message.id, messageId))
    if (!current) return "decided"
    const parts = await this.#db.select().from(messagePart).where(eq(messagePart.messageId, messageId))
    const graph = (current.graph ?? {}) as Partial<GraphMeta> & { from?: { address?: string | null } | null }
    const content = contentOf(parsed, {
      id: current.graphId,
      folder: current.folder,
      receivedDateTime: graph.receivedDateTime ?? null,
      internetMessageId: graph.internetMessageId ?? null,
      subject: null,
      from: { address: graph.from?.address ?? null, name: null },
    })
    const before = (current.fieldScans ?? {}) as Scans
    const texts = fieldTexts(content)
    const pending: Partial<Record<TextField, string>> = {}
    for (const field of waitingFields(before)) if (texts[field] !== undefined) pending[field] = texts[field]
    const decidedFields = await scanFields(this.#files, pending)

    const outcomes = new Map<string, ScanOutcome | "too_large" | "changed">()
    for (const part of parts.filter((row) => row.status === "waiting")) {
      const fresh = parsed.parts[part.index]
      // The same content as the first time, or the part is not what was taken in.
      if (!fresh || sha256Of(fresh.content) !== part.sha256) {
        outcomes.set(part.id, "changed")
        continue
      }
      try {
        outcomes.set(part.id, await this.#files.scan(fresh.content, part.fileName))
      } catch (error) {
        if (!(error instanceof FileTooLargeError)) throw error
        outcomes.set(part.id, "too_large")
      }
    }
    // The raw message again: while it waits, and when it scanned clean but was not kept because a part waited (G6).
    const rawOutcome =
      current.rawStatus === "waiting" || (current.rawStatus === "clean" && !current.rawSha256)
        ? await this.#files.scan(raw, null)
        : null

    let stillWaiting = false
    await this.#db.transaction(async (tx) => {
      const [locked] = await tx.select().from(message).where(eq(message.id, messageId)).for("update")
      if (!locked) return
      const rows = await tx.select().from(messagePart).where(eq(messagePart.messageId, messageId))

      // Text fields.
      const lockedScans = (locked.fieldScans ?? {}) as Scans
      const scans: Scans = { ...lockedScans }
      for (const field of waitingFields(lockedScans)) {
        const decided = decidedFields[field]
        if (!decided) scans[field] = { status: "unavailable", signature: null, blockedBy: null }
        else if (decided.status === "waiting") stillWaiting = true
        else scans[field] = decided
      }
      const columns = columnsOf(content, scans)
      const patch: Partial<typeof message.$inferInsert> = { fieldScans: scans }
      const changed = (field: TextField) =>
        lockedScans[field]?.status === "waiting" && scans[field]?.status !== "waiting"
      if (changed("text")) patch.textBody = columns.textBody
      if (changed("html")) patch.htmlBody = columns.htmlBody
      if (changed("headers")) {
        Object.assign(patch, {
          subject: columns.subject,
          fromName: columns.fromName,
          toAddresses: columns.toAddresses,
          ccAddresses: columns.ccAddresses,
          headers: columns.headers,
        })
        const names = partNamesOf(content, scans)
        for (const row of rows) {
          const name = names[row.index]
          if (name) await tx.update(messagePart).set(name).where(eq(messagePart.id, row.id))
        }
      }
      if (Object.values(scans).some((scan) => refused(scan)))
        patch.reviewFlags = [...new Set([...locked.reviewFlags, "blocked_content"])]
      await auditBlockedFields(tx, messageId, lockedScans, scans)

      // Parts.
      for (const row of rows) {
        const outcome = outcomes.get(row.id)
        if (!outcome || row.status !== "waiting") continue
        if (outcome === "changed" || outcome === "too_large") {
          await tx
            .update(messagePart)
            .set(
              outcome === "too_large"
                ? { status: "too_large", updatedAt: this.#now() }
                : { status: "unavailable", unavailableReason: "changed", updatedAt: this.#now() },
            )
            .where(eq(messagePart.id, row.id))
          row.status = outcome === "too_large" ? "too_large" : "unavailable"
          continue
        }
        if (outcome.status === "waiting") {
          stillWaiting = true
          continue
        }
        const status = outcome.status as PartStatus
        const fresh = parsed.parts[row.index]
        if (isStored(status) && fresh) await this.#files.storeIn(tx, fresh.content, outcome)
        await tx
          .update(messagePart)
          .set({
            status,
            signature: outcome.signature,
            blockedBy: outcome.status === "blocked_type" ? outcome.blockedBy : null,
            storedSha256: isStored(status) ? outcome.sha256 : null,
            updatedAt: this.#now(),
          })
          .where(eq(messagePart.id, row.id))
        await auditBlockedPart(tx, "waiting", outcome, {
          ticketId: locked.ticketId,
          messageId,
          partId: row.id,
          fileName: row.fileName,
        })
        row.status = status
      }

      // The raw message: kept only when it and every part scanned clean.
      let rawStatus = locked.rawStatus
      if (rawOutcome && locked.rawStatus === "waiting") {
        if (rawOutcome.status === "waiting") stillWaiting = true
        else rawStatus = rawOutcome.status
      }
      const keep =
        rawOutcome !== null &&
        rawOutcome.status === "clean" &&
        rawStatus === "clean" &&
        !locked.rawSha256 &&
        rows.every((row) => row.status === "clean") &&
        Object.values(scans).every((scan) => scan?.status === "clean")
      if (keep) await this.#files.storeIn(tx, raw, rawOutcome)
      if (rawStatus !== locked.rawStatus) patch.rawStatus = rawStatus
      if (keep) patch.rawSha256 = rawOutcome.sha256
      await tx.update(message).set(patch).where(eq(message.id, messageId))
    })
    return stillWaiting ? "waiting" : "decided"
  }
}
