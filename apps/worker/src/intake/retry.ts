// Files left waiting (plan 2.3, P5, P13): while files wait for the scanner, this job fetches their messages again from
// Graph, by the message's own source (its mailbox) and immutable ID with the credential in effect now, and scans the
// waiting parts (and a waiting raw message) again. Finishing what was already taken in is not tied to the current
// source. A 401, 403, or 404 (the message, or access to its old mailbox, is gone) makes the file `unavailable` with that
// status as its reason, so no file waits for ever; any other failure leaves it waiting for the next run.

import type { Db } from "@maane/server/db/client"
import { intakeSource, message, messagePart } from "@maane/server/db/schema"
import { errorFacts, log } from "@maane/server/log"
import type { Settings } from "@maane/server/settings/service"
import { type PartStatus, STORED_STATUSES, type StoredStatus } from "@maane/shared"
import { and, eq, exists, or } from "drizzle-orm"
import { auditBlockedPart, type FileService, FileTooLargeError, type ScanOutcome, sha256Of } from "../files/service.ts"
import { type GraphGateway, graphConfig, graphStatus, isGone } from "./graph.ts"
import { type ParsedMessage, parseMessage } from "./parse.ts"

/** The most messages one run fetches again. */
export const MAX_RETRIES_PER_RUN = 50

const isStored = (status: PartStatus): status is StoredStatus => (STORED_STATUSES as readonly string[]).includes(status)

export interface RetrySummary {
  messages: number
  decided: number
  unavailable: number
  stillWaiting: number
}

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

  async run(): Promise<RetrySummary> {
    const summary: RetrySummary = { messages: 0, decided: 0, unavailable: 0, stillWaiting: 0 }
    const waiting = await this.#db
      .select({
        id: message.id,
        graphId: message.graphId,
        mailbox: intakeSource.mailbox,
        rawStatus: message.rawStatus,
      })
      .from(message)
      .innerJoin(intakeSource, eq(intakeSource.id, message.sourceId))
      .where(
        or(
          eq(message.rawStatus, "waiting"),
          exists(
            this.#db
              .select({ id: messagePart.id })
              .from(messagePart)
              .where(and(eq(messagePart.messageId, message.id), eq(messagePart.status, "waiting"))),
          ),
        ),
      )
      .orderBy(message.receivedAt)
      .limit(MAX_RETRIES_PER_RUN)
    if (waiting.length === 0) return summary
    const config = await graphConfig(this.#settings)
    if (!config) return { ...summary, stillWaiting: waiting.length }
    const limit = await this.#settings.get("files.maxBytes")
    for (const item of waiting) {
      summary.messages++
      let bytes: Buffer | null = null
      let gone: string | null = null
      try {
        const fetched = await this.#graph.mime(config, item.mailbox, item.graphId, limit)
        if (fetched.kind === "too_large") gone = "too_large"
        else bytes = fetched.bytes
      } catch (error) {
        const status = graphStatus(error)
        if (isGone(status)) gone = `graph_${status}`
        else {
          log.warn("fetching a message again for its waiting files failed; they keep waiting", errorFacts(error))
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

  /** The waiting parts and raw message of a message become unavailable, with the reason. */
  async #unavailable(messageId: string, reason: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.select({ id: message.id }).from(message).where(eq(message.id, messageId)).for("update")
      await tx
        .update(messagePart)
        .set({ status: "unavailable", unavailableReason: reason, updatedAt: this.#now() })
        .where(and(eq(messagePart.messageId, messageId), eq(messagePart.status, "waiting")))
      await tx
        .update(message)
        .set({ rawStatus: "unavailable" })
        .where(and(eq(message.id, messageId), eq(message.rawStatus, "waiting")))
    })
    log.info("waiting files became unavailable", { reason })
  }

  /** Scans the waiting parts again; returns whether anything still waits. */
  async #rescan(messageId: string, raw: Buffer, parsed: ParsedMessage): Promise<"waiting" | "decided"> {
    const parts = await this.#db.select().from(messagePart).where(eq(messagePart.messageId, messageId))
    const [current] = await this.#db.select().from(message).where(eq(message.id, messageId))
    if (!current) return "decided"
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
    const rawOutcome = current.rawStatus === "waiting" ? await this.#files.scan(raw, null) : null

    let stillWaiting = false
    await this.#db.transaction(async (tx) => {
      const [locked] = await tx.select().from(message).where(eq(message.id, messageId)).for("update")
      if (!locked) return
      const rows = await tx.select().from(messagePart).where(eq(messagePart.messageId, messageId))
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
      let rawStatus = locked.rawStatus
      if (rawOutcome && locked.rawStatus === "waiting") {
        if (rawOutcome.status === "waiting") stillWaiting = true
        else rawStatus = rawOutcome.status
      }
      // The raw MIME is kept only when it and every part scanned clean.
      const keep =
        rawOutcome !== null && rawStatus === "clean" && !locked.rawSha256 && rows.every((row) => row.status === "clean")
      if (keep) await this.#files.storeIn(tx, raw, rawOutcome)
      if (rawStatus !== locked.rawStatus || keep)
        await tx
          .update(message)
          .set({ rawStatus, ...(keep ? { rawSha256: rawOutcome.sha256 } : {}) })
          .where(eq(message.id, messageId))
    })
    return stillWaiting ? "waiting" : "decided"
  }
}
