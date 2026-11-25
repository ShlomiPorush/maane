import type { Db } from "@maane/server/db/client"
import {
  intakeRecord,
  message,
  outbox,
  supportAddress,
  ticket,
  ticketLink,
  ticketParticipant,
  ticketPendingReference,
} from "@maane/server/db/schema"
import { flagSameMail } from "@maane/server/imports/overlap"
import { type PushJob, transactionWithJobs } from "@maane/server/jobs/queue"
import { errorFacts, log } from "@maane/server/log"
import { hasDefaultAddress } from "@maane/server/organizations/intake"
import { databaseError } from "@maane/server/organizations/refusal"
import { customerReplied, type IntakeFacts, isCustomerReply } from "@maane/server/tickets/customer-reply"
import { lockTicketNumbers } from "@maane/server/tickets/numbers"
import { lockTicket } from "@maane/server/tickets/status"
import {
  type IntakeOutcome,
  type LinkReason,
  type MatchLayer,
  type MessageFlag,
  matchSupportAddress,
  resolveSupportAddress,
  type TicketFlag,
} from "@maane/shared"
import { and, asc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm"
import type { Db as QueueDb } from "pg-boss"
import { applyDeliveryReport } from "../delivery/reports.ts"
import type { Tx } from "../files/types.ts"
import type { AutomatedSign, Classification } from "./classify.ts"
import type { MailAddress } from "./parse.ts"
import { newReferenceCode, referenceCodesIn, referencedIds, ticketNumbersIn } from "./threading.ts"

type MessageRow = typeof message.$inferSelect
type Rule = { kind: "exact" | "pattern"; value: string; isDefault: boolean; organizationId: string }

export interface ProcessHooks {
  afterLock?: (messageId: string) => Promise<void>
}

export const MAX_PER_RUN = 500
export const MAX_PROCESS_ATTEMPTS = 3
export const DEPENDENCY_WAIT_MS = 60 * 60_000

type Match =
  | { kind: "ticket"; ticketId: string; layer: MatchLayer }
  | { kind: "ambiguous"; holders: string[]; layer: "original" }
  | { kind: "none" }

type RecordFields = Omit<typeof intakeRecord.$inferInsert, "messageId" | "outcome"> & { outcome: IntakeOutcome }

export function notificationOf(record: IntakeFacts, messageId: string): PushJob | null {
  const ticketId = record.ticketId
  if (!ticketId) return null
  if (isCustomerReply(record)) return { kind: "customer_reply", ticketId, messageId }
  if (record.outcome === "new_ticket" || record.outcome === "new_linked_ticket")
    return { kind: "new_ticket", ticketId, messageId }
  return null
}

export async function recordNotRead(tx: Tx, messageId: string): Promise<void> {
  await tx.insert(intakeRecord).values({ messageId, outcome: "unreadable", reason: "not_read" })
}

async function recordOutcome(tx: Tx, record: RecordFields & { messageId: string }): Promise<void> {
  await tx.delete(intakeRecord).where(eq(intakeRecord.messageId, record.messageId))
  await tx.insert(intakeRecord).values(record)
}

export type Notify = (jobs: QueueDb, job: PushJob) => Promise<void>

const sameTime = (a: Date | null, b: Date | null) => (a === null || b === null ? a === b : a.getTime() === b.getTime())

const addressesOf = (value: unknown): MailAddress[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is MailAddress => typeof (entry as MailAddress)?.address === "string")
    : []

const FIELDS_WAITING = sql`(${message.content} = 'parsed' and jsonb_path_exists(${message.fieldScans}, '$.* ? (@.status == "waiting")'))`

const isRefused = (error: unknown) => /^(22|54|08P01)/.test(databaseError(error)?.code ?? "")

const firstFound = <T>(order: readonly T[], found: Map<T, string>) => {
  for (const item of order) {
    const ticketId = found.get(item)
    if (ticketId) return ticketId
  }
  return null
}

export class IntakeProcessor {
  readonly #db: Db
  readonly #now: () => Date
  readonly #notify?: Notify

  constructor(options: { db: Db; now?: () => Date; notify?: Notify }) {
    this.#db = options.db
    this.#notify = options.notify
    this.#now = options.now ?? (() => new Date())
  }

  async run(hooks: ProcessHooks = {}, limit = MAX_PER_RUN): Promise<{ processed: number; failed: number }> {
    const failed: string[] = []
    let processed = 0
    while (processed + failed.length < limit) {
      if (!(await hasDefaultAddress(this.#db))) break
      const since = new Date(this.#now().getTime() - DEPENDENCY_WAIT_MS)
      const waitsForOriginal = sql`(${message.createdAt} > ${since} and exists (select 1 from message o
        where o.state = 'stored' and o.created_at < ${message.createdAt} and o.message_id_header is not null
        and o.message_id_header = any(${message.inReplyTo} || ${message.references})))`
      const [next] = await this.#db
        .select({ id: message.id, attempts: message.processAttempts })
        .from(message)
        .where(
          and(
            eq(message.state, "stored"),
            sql`not ${FIELDS_WAITING}`,
            sql`not ${waitsForOriginal}`,
            failed.length ? notInArray(message.id, failed) : undefined,
          ),
        )
        .orderBy(asc(message.receivedAt), asc(message.createdAt), asc(message.id))
        .limit(1)
      if (!next) break
      try {
        await this.processOne(next.id, hooks)
        processed++
      } catch (error) {
        const attempts = next.attempts + 1
        await this.#db.update(message).set({ processAttempts: attempts }).where(eq(message.id, next.id))
        if ((isRefused(error) || attempts >= MAX_PROCESS_ATTEMPTS) && (await this.#giveUp(next.id))) {
          log.warn("processing a message failed for good; it is recorded for review", errorFacts(error))
          processed++
          continue
        }
        failed.push(next.id)
        log.error("processing a stored message failed; it stays stored", errorFacts(error))
      }
    }
    if (processed > 0) log.info("intake processed messages", { processed })
    return { processed, failed: failed.length }
  }

  async #giveUp(id: string): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: message.id, reviewFlags: message.reviewFlags })
        .from(message)
        .where(and(eq(message.id, id), eq(message.state, "stored")))
        .for("update")
      if (!row) return false
      await tx
        .update(message)
        .set({
          state: "processed",
          processedAt: this.#now(),
          reviewFlags: [...new Set([...row.reviewFlags, "store_failed"])],
        })
        .where(eq(message.id, id))
      await recordOutcome(tx, { messageId: id, outcome: "unreadable", reason: "process_failed" })
      return true
    })
  }

  async processOne(id: string, hooks: ProcessHooks = {}): Promise<void> {
    const work = async (tx: Tx, jobs: QueueDb | null) => {
      await lockTicketNumbers(tx)
      await hooks.afterLock?.(id)
      const [row] = await tx
        .select()
        .from(message)
        .where(and(eq(message.id, id), eq(message.state, "stored")))
        .for("update")
      if (!row) return
      if (!(await hasDefaultAddress(tx))) return
      const notifications: PushJob[] = []
      await this.#process(tx, row, notifications)
      if (jobs && this.#notify) for (const job of notifications) await this.#notify(jobs, job)
    }
    const notify = this.#notify
    if (notify) await transactionWithJobs(this.#db, (tx, jobs) => work(tx as unknown as Tx, jobs))
    else await this.#db.transaction((tx) => work(tx, null))
  }

  async #process(tx: Tx, msg: MessageRow, notifications: PushJob[]): Promise<void> {
    const flags = new Set<string>(msg.reviewFlags)
    const finish = async (patch: Partial<MessageRow>, record: RecordFields) => {
      await tx
        .update(message)
        .set({ ...patch, reviewFlags: [...flags], state: "processed", processedAt: this.#now() })
        .where(eq(message.id, msg.id))
      await recordOutcome(tx, { messageId: msg.id, ...record })
      const notification = notificationOf(record, msg.id)
      if (notification) notifications.push(notification)
    }

    if (msg.content !== "parsed") return finish({}, { outcome: "unreadable", reason: msg.content })

    if (msg.messageIdHeader && msg.fromAddress) {
      const [own] = await tx
        .select({ id: outbox.messageId, ticketId: message.ticketId })
        .from(outbox)
        .innerJoin(message, eq(message.id, outbox.messageId))
        .where(and(eq(outbox.messageIdHeader, msg.messageIdHeader), eq(outbox.fromAddress, msg.fromAddress)))
      if (own)
        return finish(
          { duplicateOf: own.id },
          { outcome: "copy", matchedMessageId: own.id, matchedTicketId: own.ticketId, reason: "sent_by_maane" },
        )
    }

    if (msg.messageIdHeader) {
      const earlier = await tx
        .select({
          id: message.id,
          fromAddress: message.fromAddress,
          sentAt: message.sentAt,
          contentHash: message.contentHash,
          ticketId: message.ticketId,
          duplicateOf: message.duplicateOf,
        })
        .from(message)
        .where(
          and(
            eq(message.messageIdHeader, msg.messageIdHeader),
            ne(message.id, msg.id),
            eq(message.state, "processed"),
            eq(message.content, "parsed"),
          ),
        )
        .orderBy(asc(message.receivedAt))
        .limit(200)
      const copy = earlier.find(
        (other) =>
          other.fromAddress === msg.fromAddress &&
          sameTime(other.sentAt, msg.sentAt) &&
          other.contentHash === msg.contentHash,
      )
      if (copy) {
        const original = copy.duplicateOf ?? copy.id
        return finish(
          { duplicateOf: original },
          { outcome: "copy", matchedMessageId: original, matchedTicketId: copy.ticketId, reason: "copy" },
        )
      }
      if (earlier.length > 0) flags.add("reused_message_id" satisfies MessageFlag)
    }

    if (msg.classification === null) throw new Error("a parsed message was stored without its classification")
    const classification: Classification = {
      automated: msg.classification === "automated",
      signs: msg.automatedReasons as AutomatedSign[],
      possiblyAutomated: msg.possiblyAutomated,
    }
    const rules = (await tx
      .select({
        kind: supportAddress.kind,
        value: supportAddress.value,
        isDefault: supportAddress.isDefault,
        organizationId: supportAddress.organizationId,
      })
      .from(supportAddress)) as Rule[]
    const to = addressesOf(msg.toAddresses)
    const cc = addressesOf(msg.ccAddresses)
    const resolution = resolveSupportAddress(
      [...to, ...cc].map((entry) => entry.address),
      rules,
    )
    if (resolution.via === "none") throw new Error("no support address matched and no default address exists")
    const address = {
      supportAddress: resolution.via === "default" ? resolution.rule.value : resolution.address,
      organizationId: resolution.rule.organizationId,
    }

    const match = await this.#match(tx, msg)
    const base: RecordFields = {
      outcome: "new_ticket",
      classification: classification.automated ? "automated" : "customer",
      supportAddress: address.supportAddress,
      organizationId: address.organizationId,
      ...(match.kind === "ticket" ? { matchedTicketId: match.ticketId } : {}),
      matchLayer: match.kind === "none" ? null : match.layer,
    }
    const patch: Partial<MessageRow> = {
      classification: base.classification,
      automatedReasons: classification.signs,
    }

    if (classification.automated) {
      const report = await applyDeliveryReport(tx, msg)
      return finish(patch, {
        ...base,
        outcome: "automated",
        reason: classification.signs.join(","),
        ...(report ? { matchedMessageId: report.messageId, matchedTicketId: report.ticketId } : {}),
      })
    }

    const sender = msg.fromAddress
    let links: string[] = []
    let linkReason: LinkReason | null = null
    if (match.kind === "ticket") {
      const ticketId = match.ticketId
      const locked = await lockTicket(tx, ticketId)
      const participant = sender !== null && (await this.#isParticipant(tx, ticketId, sender))
      if (participant && locked?.status !== "closed") {
        await this.#keepPending(tx, msg, ticketId)
        if (msg.messageIdHeader) await this.#resolvePending(tx, ticketId, msg.messageIdHeader, msg.id)
        const record: RecordFields = { ...base, ticketId, outcome: "joined" }
        if (isCustomerReply(record)) await customerReplied(tx, ticketId, this.#now())
        await finish({ ...patch, ticketId }, record)
        await flagSameMail(tx, ticketId)
        return
      }
      links = [ticketId]
      linkReason = participant ? "follow_up" : "sender_not_participant"
    } else if (match.kind === "ambiguous") {
      links = match.holders
      linkReason = "ambiguous_original"
    }

    const outcome: IntakeOutcome = linkReason ? "new_linked_ticket" : "new_ticket"
    const ticketFlags: TicketFlag[] = []
    if (classification.possiblyAutomated) ticketFlags.push("possibly_automated")
    if (linkReason && linkReason !== "follow_up") ticketFlags.push(linkReason)
    const opened = await this.#open(tx, {
      organizationId: address.organizationId,
      supportAddress: address.supportAddress,
      subject: msg.subject,
      flags: ticketFlags,
    })
    if (msg.fromAddress) await this.#addParticipant(tx, opened, msg.fromAddress, msg.fromName)
    for (const entry of cc)
      if (entry.address !== msg.fromAddress && !matchSupportAddress(entry.address, rules))
        await this.#addParticipant(tx, opened, entry.address, entry.name)
    for (const linked of links)
      await tx
        .insert(ticketLink)
        .values({ ticketId: opened, linkedTicketId: linked, reason: linkReason ?? "sender_not_participant" })
        .onConflictDoNothing()
    await this.#keepPending(tx, msg, opened)
    return finish({ ...patch, ticketId: opened }, { ...base, ticketId: opened, outcome, reason: linkReason })
  }

  async #match(tx: Tx, msg: MessageRow): Promise<Match> {
    for (const id of referencedIds(msg.inReplyTo, msg.references)) {
      const byMessage = await this.#ticketsOf(tx, id)
      if (byMessage.length > 1) continue
      const tickets = new Set([...byMessage, ...(await this.#waitingFor(tx, id))])
      const [only] = tickets
      if (tickets.size === 1 && only) return { kind: "ticket", ticketId: only, layer: "header" }
    }
    if (msg.messageIdHeader) {
      const holders = await this.#waitingFor(tx, msg.messageIdHeader)
      const [only] = holders
      if (holders.length === 1 && only) return { kind: "ticket", ticketId: only, layer: "original" }
      if (holders.length > 1) return { kind: "ambiguous", holders, layer: "original" }
    }
    const codes = referenceCodesIn(msg.textBody)
    if (codes.length) {
      const rows = await tx
        .select({ id: ticket.id, code: ticket.referenceCode })
        .from(ticket)
        .where(inArray(ticket.referenceCode, codes))
      const found = firstFound(codes, new Map(rows.map((row) => [row.code, row.id])))
      if (found) return { kind: "ticket", ticketId: found, layer: "reference" }
    }
    const numbers = ticketNumbersIn(msg.subject)
    if (numbers.length) {
      const rows = await tx
        .select({ id: ticket.id, number: ticket.number })
        .from(ticket)
        .where(inArray(ticket.number, numbers))
      const found = firstFound(numbers, new Map(rows.map((row) => [row.number, row.id])))
      if (found) return { kind: "ticket", ticketId: found, layer: "subject" }
    }
    return { kind: "none" }
  }

  async #ticketsOf(tx: Tx, id: string): Promise<string[]> {
    const rows = await tx
      .selectDistinct({ ticketId: message.ticketId })
      .from(message)
      .where(and(eq(message.messageIdHeader, id), isNotNull(message.ticketId), eq(message.content, "parsed")))
    return rows.flatMap((row) => (row.ticketId ? [row.ticketId] : []))
  }

  async #waitingFor(tx: Tx, id: string): Promise<string[]> {
    const rows = await tx
      .select({ ticketId: ticketPendingReference.ticketId })
      .from(ticketPendingReference)
      .where(and(eq(ticketPendingReference.messageIdHeader, id), isNull(ticketPendingReference.resolvedBy)))
      .orderBy(asc(ticketPendingReference.createdAt))
    return [...new Set(rows.map((row) => row.ticketId))]
  }

  async #isParticipant(tx: Tx, ticketId: string, address: string): Promise<boolean> {
    const rows = await tx
      .select({ address: ticketParticipant.address })
      .from(ticketParticipant)
      .where(and(eq(ticketParticipant.ticketId, ticketId), eq(ticketParticipant.address, address)))
    return rows.length > 0
  }

  async #open(
    tx: Tx,
    values: { organizationId: string; supportAddress: string; subject: string | null; flags: TicketFlag[] },
  ): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const [row] = await tx
        .insert(ticket)
        .values({
          referenceCode: newReferenceCode(),
          organizationId: values.organizationId,
          supportAddress: values.supportAddress,
          subject: values.subject,
          status: "new",
          reviewFlags: values.flags,
          createdAt: this.#now(),
          lastActivityAt: this.#now(),
        })
        .onConflictDoNothing({ target: ticket.referenceCode })
        .returning({ id: ticket.id })
      if (row) return row.id
    }
    throw new Error("no free reference code after 8 draws")
  }

  async #addParticipant(tx: Tx, ticketId: string, address: string, name: string | null): Promise<void> {
    await tx.insert(ticketParticipant).values({ ticketId, address, name }).onConflictDoNothing()
  }

  async #keepPending(tx: Tx, msg: MessageRow, ticketId: string): Promise<void> {
    const ids = referencedIds(msg.inReplyTo, msg.references).filter((id) => id !== msg.messageIdHeader)
    if (ids.length === 0) return
    const known = await tx
      .selectDistinct({ id: message.messageIdHeader })
      .from(message)
      .where(and(inArray(message.messageIdHeader, ids), eq(message.state, "processed"), eq(message.content, "parsed")))
    const present = new Set(known.map((row) => row.id))
    const missing = ids.filter((candidate) => !present.has(candidate))
    if (missing.length)
      await tx
        .insert(ticketPendingReference)
        .values(missing.map((id) => ({ ticketId, messageIdHeader: id })))
        .onConflictDoNothing()
  }

  async #resolvePending(tx: Tx, ticketId: string, id: string, by: string): Promise<void> {
    await tx
      .update(ticketPendingReference)
      .set({ resolvedBy: by })
      .where(
        and(
          eq(ticketPendingReference.ticketId, ticketId),
          eq(ticketPendingReference.messageIdHeader, id),
          isNull(ticketPendingReference.resolvedBy),
        ),
      )
  }
}
