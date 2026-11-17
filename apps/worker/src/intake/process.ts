// Stage two of intake (plan 2.3, P6, P7, P8, P11, P16): processes stored messages, oldest first by Graph's receive
// time, each in its own transaction, idempotent by the message's state. Maane is live from the first moment (phase 6):
// every message is processed into tickets. Messages already stored are processed whatever the current source is: they
// are mail that really arrived. A message waits while one of its text fields waits for the scanner (content.ts), and
// while a message it refers to is stored but not processed yet (review G15), for at most DEPENDENCY_WAIT_MS. While no
// default address exists, nothing is processed at all (no message is picked, no attempt counted): every waiting
// message is processed once, in the usual order, after one exists (apps/server/src/organizations/intake.ts).
//
// For each message: a copy of an earlier one is recorded and changes nothing; automated mail opens, joins, and reopens
// nothing; otherwise the support address (To, then Cc, then the default) and the threading layers decide between
// joining a ticket, a new ticket, and a new ticket linked to the ones it matched (plan 4.1: a participant's reply to a
// closed ticket opens a follow-up linked to it; the closed ticket is not changed). Joining a ticket is a customer reply,
// which takes effect in apps/server/src/tickets/customer-reply.ts. Lock order: the ticket number lock
// (apps/server/src/tickets/numbers.ts), the message, then the ticket; the sender's participation and the ticket's
// status are read under the ticket's lock (phase 6), so a rerun of the import that changed the participants just
// before is never acted on with a stale answer.

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
import { type AutomatedSign, type Classification, classify } from "./classify.ts"
import type { StoredContentType } from "./content.ts"
import type { MailAddress } from "./parse.ts"
import { newReferenceCode, referenceCodesIn, referencedIds, ticketNumbersIn } from "./threading.ts"

type MessageRow = typeof message.$inferSelect
type Rule = { kind: "exact" | "pattern"; value: string; isDefault: boolean; organizationId: string }

export interface ProcessHooks {
  /** Right after the transaction took the ticket number lock: a test holds a transaction here. */
  afterLock?: (messageId: string) => Promise<void>
}

/** The most messages one run processes; the next run (every minute) goes on. */
export const MAX_PER_RUN = 500
/** Failed runs on one message before it is recorded for review instead of being tried for ever (review G2). */
export const MAX_PROCESS_ATTEMPTS = 3
/**
 * How long a reply may wait, counted from its own storing, for a stored message it refers to that is not processed yet
 * (review G15, G16). Past this it is processed whatever arrived meanwhile, so no sender can delay it longer.
 */
export const DEPENDENCY_WAIT_MS = 60 * 60_000

type Match =
  | { kind: "ticket"; ticketId: string; layer: MatchLayer }
  | { kind: "ambiguous"; holders: string[]; layer: "original" }
  | { kind: "none" }

type RecordFields = Omit<typeof intakeRecord.$inferInsert, "messageId" | "outcome"> & { outcome: IntakeOutcome }

/**
 * Whether a processed message notifies agents (plan 4.5), the one place that decides it: a message that opened a
 * ticket (among them the follow-up a reply to a closed ticket opens, plan 4.1), and exactly what `isCustomerReply`
 * (apps/server/src/tickets/customer-reply.ts) counts as a customer reply. Automated mail and copies never notify.
 */
export function notificationOf(record: IntakeFacts, messageId: string): PushJob | null {
  const ticketId = record.ticketId
  if (!ticketId) return null
  if (isCustomerReply(record)) return { kind: "customer_reply", ticketId, messageId }
  if (record.outcome === "new_ticket" || record.outcome === "new_linked_ticket")
    return { kind: "new_ticket", ticketId, messageId }
  return null
}

/** Queues a notification inside the transaction that stores its message (pg-boss's documented `db` option). */
export type Notify = (jobs: QueueDb, job: PushJob) => Promise<void>

const sameTime = (a: Date | null, b: Date | null) => (a === null || b === null ? a === b : a.getTime() === b.getTime())

const addressesOf = (value: unknown): MailAddress[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is MailAddress => typeof (entry as MailAddress)?.address === "string")
    : []

/** A message whose text fields still wait for the scanner: processing waits for the retry to decide them. */
const FIELDS_WAITING = sql`(${message.content} = 'parsed' and jsonb_path_exists(${message.fieldScans}, '$.* ? (@.status == "waiting")'))`

/** A database error the message's own values caused (data exception, program limit, a protocol violation). */
const isRefused = (error: unknown) => /^(22|54|08P01)/.test(databaseError(error)?.code ?? "")

/** The first item of a list that a query found, in the list's order. */
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

  /**
   * Processes stored messages, oldest first, while a default address exists. A message whose transaction fails stays
   * stored and is skipped for the rest of this run; after MAX_PROCESS_ATTEMPTS failed runs, or at once when the
   * database refuses one of its values, it is recorded for review, so no message is tried for ever.
   */
  async run(hooks: ProcessHooks = {}, limit = MAX_PER_RUN): Promise<{ processed: number; failed: number }> {
    const failed: string[] = []
    let processed = 0
    while (processed + failed.length < limit) {
      // No default address: nothing is picked and no attempt is counted; the messages wait for one.
      if (!(await hasDefaultAddress(this.#db))) break
      const since = new Date(this.#now().getTime() - DEPENDENCY_WAIT_MS)
      // A reply waits while a message it refers to was stored strictly before it and is not processed yet, and only
      // while the reply itself was stored less than the limit ago. Strictly earlier: two messages never wait for each
      // other, and nothing stored later can hold it.
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

  /** A message processing cannot finish: processed without a ticket, flagged, and recorded. */
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
      await tx.insert(intakeRecord).values({ messageId: id, outcome: "unreadable", reason: "process_failed" })
      return true
    })
  }

  /**
   * One message in its own transaction. Does nothing when it was processed already, or while no default address
   * exists (the message stays stored, and nothing counts as an attempt).
   */
  async processOne(id: string, hooks: ProcessHooks = {}): Promise<void> {
    const work = async (tx: Tx, jobs: QueueDb | null) => {
      // Before the message and any ticket: the same order as the import's (apps/server/src/tickets/numbers.ts).
      await lockTicketNumbers(tx)
      await hooks.afterLock?.(id)
      const [row] = await tx
        .select()
        .from(message)
        .where(and(eq(message.id, id), eq(message.state, "stored")))
        .for("update")
      if (!row) return
      // A default address, once it exists, is only ever replaced, never removed (organizations/service.ts).
      if (!(await hasDefaultAddress(tx))) return
      const notifications: PushJob[] = []
      await this.#process(tx, row, notifications)
      // The notification's job commits with the message, or neither does (plan 4.5).
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
      await tx.insert(intakeRecord).values({ messageId: msg.id, ...record })
      const notification = notificationOf(record, msg.id)
      if (notification) notifications.push(notification)
    }

    if (msg.content !== "parsed") return finish({}, { outcome: "unreadable", reason: msg.content })

    // Maane's own reply coming back into the mailbox (a support address among its recipients, a copy a provider kept):
    // its own Message-ID from its own From address (plan 3.1). It opens, joins, and reopens nothing.
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

    // A copy (P7): the same Message-ID, From, Date, and decoded content as an earlier message. Recorded, nothing else.
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

    // Classified at stage one from the parsed headers, also when their stored text was dropped (review G13).
    const classification: Classification =
      msg.classification !== null
        ? {
            automated: msg.classification === "automated",
            signs: msg.automatedReasons as AutomatedSign[],
            possiblyAutomated: msg.possiblyAutomated,
          }
        : classify({
            headers: Array.isArray(msg.headers) ? (msg.headers as { key: string; line: string }[]) : [],
            contentType: (msg.contentType as StoredContentType | null) ?? { value: "text/plain", reportType: null },
            from: msg.fromAddress,
          })
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
    // To, then Cc, against the address table; no match uses the default (P8), which processOne checked exists. The
    // concrete address is kept.
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

    // Automated mail never opens, joins, or reopens a ticket (requirements 2.2). A report keeps its original Message-ID;
    // a delivery report about one of Maane's replies updates its recipients' delivery status (plan 3.3).
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
      // The ticket's lock first, then what decides: its status and the sender's participation, read under the lock.
      const locked = await lockTicket(tx, ticketId)
      const participant = sender !== null && (await this.#isParticipant(tx, ticketId, sender))
      if (participant && locked?.status !== "closed") {
        await this.#keepPending(tx, msg, ticketId)
        // Only the ticket the message joined stops waiting for it (review G3).
        if (msg.messageIdHeader) await this.#resolvePending(tx, ticketId, msg.messageIdHeader, msg.id)
        const record: RecordFields = { ...base, ticketId, outcome: "joined" }
        // The one place a customer reply takes effect (apps/server/src/tickets/customer-reply.ts).
        if (isCustomerReply(record)) await customerReplied(tx, ticketId, this.#now())
        await finish({ ...patch, ticketId }, record)
        // The same mail may have come in through the import too (phase 6): both stay, the ticket is flagged.
        await flagSameMail(tx, ticketId)
        return
      }
      // Every layer is only a hint: a sender who is not a participant opens a new ticket, linked to the old one. A
      // participant's reply to a closed ticket opens a follow-up linked to it, and the closed ticket stays as it is.
      links = [ticketId]
      linkReason = participant ? "follow_up" : "sender_not_participant"
    } else if (match.kind === "ambiguous") {
      // A late original that more than one ticket waits for: its own ticket, linked to each, never one at random.
      links = match.holders
      linkReason = "ambiguous_original"
    }

    const outcome: IntakeOutcome = linkReason ? "new_linked_ticket" : "new_ticket"
    const ticketFlags: TicketFlag[] = []
    if (classification.possiblyAutomated) ticketFlags.push("possibly_automated")
    // A follow-up needs no review; the other links do.
    if (linkReason && linkReason !== "follow_up") ticketFlags.push(linkReason)
    const opened = await this.#open(tx, {
      organizationId: address.organizationId,
      supportAddress: address.supportAddress,
      subject: msg.subject,
      flags: ticketFlags,
    })
    // Participants: From, and Cc addresses that are not support addresses.
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

  /** The threading layers, in order (requirements 2.2, P6, P7). */
  async #match(tx: Tx, msg: MessageRow): Promise<Match> {
    for (const id of referencedIds(msg.inReplyTo, msg.references)) {
      const byMessage = await this.#ticketsOf(tx, id)
      // A Message-ID on messages of more than one ticket is ambiguous and matches nothing in this layer (P7).
      if (byMessage.length > 1) continue
      const tickets = new Set([...byMessage, ...(await this.#waitingFor(tx, id))])
      const [only] = tickets
      if (tickets.size === 1 && only) return { kind: "ticket", ticketId: only, layer: "header" }
    }
    // A late original: the tickets whose messages referred to it while it was missing (P6).
    if (msg.messageIdHeader) {
      const holders = await this.#waitingFor(tx, msg.messageIdHeader)
      const [only] = holders
      if (holders.length === 1 && only) return { kind: "ticket", ticketId: only, layer: "original" }
      if (holders.length > 1) return { kind: "ambiguous", holders, layer: "original" }
    }
    // The body reference code and the subject number (review G12: the first few, in one query each).
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

  /** The tickets of parsed messages carrying this Message-ID. */
  async #ticketsOf(tx: Tx, id: string): Promise<string[]> {
    const rows = await tx
      .selectDistinct({ ticketId: message.ticketId })
      .from(message)
      .where(and(eq(message.messageIdHeader, id), isNotNull(message.ticketId), eq(message.content, "parsed")))
    return rows.flatMap((row) => (row.ticketId ? [row.ticketId] : []))
  }

  /** The tickets still waiting for this Message-ID, oldest first. */
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

  /** A number from the sequence (under the ticket number lock), a reference code from the CSPRNG (drawn again on the rare collision). */
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

  /** Each Message-ID the message refers to that no processed message carries waits on the ticket (P6). */
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
