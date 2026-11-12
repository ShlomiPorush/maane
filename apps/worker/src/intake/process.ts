// Stage two of intake (plan 2.3, P6, P7, P8, P11, P16): processes stored messages, oldest first by Graph's receive
// time, each in its own transaction, idempotent by the message's state. Each transaction first locks the intake.mode
// row FOR SHARE and reads it, so a switch (which updates that row) waits until every transaction that read the old mode
// committed, and no transaction that starts after the switch reads the old mode. Messages already stored are processed
// whatever the current source is: they are mail that really arrived, and the mode at processing time decides. A
// message waits while one of its text fields waits for the scanner (content.ts), and while a message it refers to is
// stored but not processed yet (review G15), for at most DEPENDENCY_WAIT_MS.
//
// For each message: a copy of an earlier one is recorded and changes nothing; automated mail opens, joins, and reopens
// nothing; otherwise the support address (To, then Cc, then the default) and the threading layers decide between
// joining a thread, a new thread, and a new thread linked to the ones it matched. One decision path serves both modes
// over two stores (review G4): live mode keeps tickets; listening mode keeps shadow conversations (no number, no
// reference code, no status) with the same participants, links, and pending references, and it matches existing
// tickets too, without changing them, so a listening record says exactly what live mode would have done.

import type { Db } from "@maane/server/db/client"
import {
  intakeConversation,
  intakeConversationLink,
  intakeConversationParticipant,
  intakeConversationPending,
  intakeRecord,
  message,
  setting,
  supportAddress,
  ticket,
  ticketLink,
  ticketParticipant,
  ticketPendingReference,
} from "@maane/server/db/schema"
import { errorFacts, log } from "@maane/server/log"
import { databaseError } from "@maane/server/organizations/refusal"
import {
  type IntakeMode,
  type IntakeOutcome,
  type MatchLayer,
  type MessageFlag,
  matchSupportAddress,
  resolveSupportAddress,
  SETTINGS,
  type TicketFlag,
} from "@maane/shared"
import { and, asc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm"
import type { Tx } from "../files/types.ts"
import { type AutomatedSign, type Classification, classify } from "./classify.ts"
import type { StoredContentType } from "./content.ts"
import type { MailAddress } from "./parse.ts"
import { newReferenceCode, referenceCodesIn, referencedIds, ticketNumbersIn } from "./threading.ts"

type MessageRow = typeof message.$inferSelect
type Rule = { kind: "exact" | "pattern"; value: string; isDefault: boolean; organizationId: string }

export interface ProcessHooks {
  /** Right after the transaction locked and read the intake mode: a test holds a transaction here. */
  afterMode?: (mode: IntakeMode, messageId: string) => Promise<void>
}

/** The most messages one run processes; the next run (every minute) goes on. */
export const MAX_PER_RUN = 500
/** Failed runs on one message before it is recorded for review instead of being tried for ever (review G2). */
export const MAX_PROCESS_ATTEMPTS = 3
/**
 * How long a reply waits for a stored message it refers to that is not processed yet (review G15). Past this, it is
 * processed anyway, so an original that waits for ever cannot hold its replies for ever.
 */
export const DEPENDENCY_WAIT_MS = 60 * 60_000

type Kind = "ticket" | "conversation"
type Thread = { kind: Kind; id: string }

type Match =
  | { kind: "thread"; thread: Thread; layer: MatchLayer }
  | { kind: "ambiguous"; holders: Thread[]; layer: "original" }
  | { kind: "none" }

type RecordFields = Omit<typeof intakeRecord.$inferInsert, "messageId" | "mode" | "outcome"> & {
  outcome: IntakeOutcome
}

/** The intake mode, locked FOR SHARE until the transaction ends (P16). The migration made the row; it always exists. */
export async function lockIntakeMode(tx: Pick<Tx, "select">): Promise<IntakeMode> {
  const [row] = await tx
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, "intake.mode"))
    .for("share")
  const parsed = SETTINGS["intake.mode"].schema.safeParse(row?.value)
  return parsed.success ? parsed.data : SETTINGS["intake.mode"].defaultValue
}

const sameTime = (a: Date | null, b: Date | null) => (a === null || b === null ? a === b : a.getTime() === b.getTime())

const addressesOf = (value: unknown): MailAddress[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is MailAddress => typeof (entry as MailAddress)?.address === "string")
    : []

/** A message whose text fields still wait for the scanner: processing waits for the retry to decide them. */
const FIELDS_WAITING = sql`(${message.content} = 'parsed' and jsonb_path_exists(${message.fieldScans}, '$.* ? (@.status == "waiting")'))`

/** A database error the message's own values caused (data exception, program limit, a protocol violation). */
const isRefused = (error: unknown) => /^(22|54|08P01)/.test(databaseError(error)?.code ?? "")

const key = (thread: Thread) => `${thread.kind}:${thread.id}`

/**
 * Where threads live: tickets or shadow conversations. Live mode matches and keeps tickets; listening mode matches
 * tickets without changing them (a read-only ticket store) and keeps conversations. Only tickets have numbers and
 * reference codes.
 */
interface ThreadStore {
  kind: Kind
  /** The threads of parsed messages carrying this Message-ID. */
  threadsOf(tx: Tx, id: string): Promise<string[]>
  /** The threads still waiting for this Message-ID, oldest first. */
  waitingFor(tx: Tx, id: string): Promise<string[]>
  /** The first of these codes, in their order, that names a thread. */
  byReferenceCodes(tx: Tx, codes: string[]): Promise<string | null>
  /** The first of these numbers, in their order, that names a thread. */
  byNumbers(tx: Tx, numbers: number[]): Promise<string | null>
  isParticipant(tx: Tx, thread: string, address: string): Promise<boolean>
  open(
    tx: Tx,
    values: { organizationId: string; supportAddress: string; subject: string | null; flags: TicketFlag[] },
  ): Promise<string>
  addParticipant(tx: Tx, thread: string, address: string, name: string | null): Promise<void>
  link(tx: Tx, thread: string, linked: string, reason: TicketFlag): Promise<void>
  /** A customer message joined: the ticket becomes open. */
  joined(tx: Tx, thread: string): Promise<void>
  keepPending(tx: Tx, thread: string, ids: string[]): Promise<void>
  resolvePending(tx: Tx, thread: string, id: string, by: string): Promise<void>
  /** The message's column for a thread it belongs to. */
  messageColumn(thread: string): Partial<MessageRow>
  /** The record's column for a thread the message opened or joined. */
  recordThread(thread: string): Partial<RecordFields>
  /** The record's column for a thread the message matched. */
  recordMatched(thread: string): Partial<RecordFields>
}

/** The first `limit` items of a list that a query found, in the list's order. */
const firstFound = <T>(order: readonly T[], found: Map<T, string>) => {
  for (const item of order) {
    const thread = found.get(item)
    if (thread) return thread
  }
  return null
}

export class IntakeProcessor {
  readonly #db: Db
  readonly #now: () => Date
  readonly #tickets: ThreadStore
  readonly #ticketsReadOnly: ThreadStore
  readonly #conversations: ThreadStore

  constructor(options: { db: Db; now?: () => Date }) {
    this.#db = options.db
    this.#now = options.now ?? (() => new Date())
    this.#tickets = this.#ticketStore(false)
    this.#ticketsReadOnly = this.#ticketStore(true)
    this.#conversations = this.#conversationStore()
  }

  /**
   * Processes stored messages, oldest first. A message whose transaction fails stays stored and is skipped for the
   * rest of this run; after MAX_PROCESS_ATTEMPTS failed runs, or at once when the database refuses one of its values,
   * it is recorded for review, so no message is tried for ever.
   */
  async run(hooks: ProcessHooks = {}, limit = MAX_PER_RUN): Promise<{ processed: number; failed: number }> {
    const failed: string[] = []
    let processed = 0
    while (processed + failed.length < limit) {
      const since = new Date(this.#now().getTime() - DEPENDENCY_WAIT_MS)
      // A reply waits while a message it refers to is stored, not processed yet, and stored less than the limit ago.
      const waitsForOriginal = sql`exists (select 1 from message o where o.state = 'stored' and o.id <> ${message.id}
        and o.message_id_header is not null and o.created_at > ${since}
        and o.message_id_header = any(${message.inReplyTo} || ${message.references}))`
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

  /** A message processing cannot finish: processed without a thread, flagged, and recorded. */
  async #giveUp(id: string): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const mode = await lockIntakeMode(tx)
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
      await tx.insert(intakeRecord).values({ messageId: id, mode, outcome: "unreadable", reason: "process_failed" })
      return true
    })
  }

  /** One message in its own transaction. Does nothing when it was processed already. */
  async processOne(id: string, hooks: ProcessHooks = {}): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const mode = await lockIntakeMode(tx)
      await hooks.afterMode?.(mode, id)
      const [row] = await tx
        .select()
        .from(message)
        .where(and(eq(message.id, id), eq(message.state, "stored")))
        .for("update")
      if (row) await this.#process(tx, row, mode)
    })
  }

  async #process(tx: Tx, msg: MessageRow, mode: IntakeMode): Promise<void> {
    const live = mode === "live"
    // New threads: tickets (live) or conversations (listening). Matching also sees tickets while listening.
    const opens = live ? this.#tickets : this.#conversations
    const stores = live ? [this.#tickets] : [this.#ticketsReadOnly, this.#conversations]
    const storeOf = (kind: Kind) => stores.find((store) => store.kind === kind) ?? opens
    const flags = new Set<string>(msg.reviewFlags)
    const finish = async (patch: Partial<MessageRow>, record: RecordFields) => {
      await tx
        .update(message)
        .set({ ...patch, reviewFlags: [...flags], state: "processed", processedAt: this.#now() })
        .where(eq(message.id, msg.id))
      await tx.insert(intakeRecord).values({ messageId: msg.id, mode, ...record })
    }

    if (msg.content !== "parsed") return finish({}, { outcome: "unreadable", reason: msg.content })

    // A copy (P7): the same Message-ID, From, Date, and decoded content as an earlier message. Recorded, nothing else.
    if (msg.messageIdHeader) {
      const earlier = await tx
        .select({
          id: message.id,
          fromAddress: message.fromAddress,
          sentAt: message.sentAt,
          contentHash: message.contentHash,
          ticketId: message.ticketId,
          conversationId: message.conversationId,
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
          {
            outcome: "copy",
            matchedMessageId: original,
            matchedTicketId: copy.ticketId,
            matchedConversationId: copy.conversationId,
            reason: "copy",
          },
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
    // To, then Cc, against the address table; no match uses the default (P8). The concrete address is kept.
    const resolution = resolveSupportAddress(
      [...to, ...cc].map((entry) => entry.address),
      rules,
    )
    const address =
      resolution.via === "none"
        ? null
        : {
            supportAddress: resolution.via === "default" ? resolution.rule.value : resolution.address,
            organizationId: resolution.rule.organizationId,
          }

    const match = await this.#match(tx, stores, msg)
    const base: RecordFields = {
      outcome: "new_ticket",
      classification: classification.automated ? "automated" : "customer",
      supportAddress: address?.supportAddress ?? null,
      organizationId: address?.organizationId ?? null,
      ...(match.kind === "thread" ? storeOf(match.thread.kind).recordMatched(match.thread.id) : {}),
      matchLayer: match.kind === "none" ? null : match.layer,
    }
    const patch: Partial<MessageRow> = {
      classification: base.classification,
      automatedReasons: classification.signs,
    }

    // Automated mail never opens, joins, or reopens a thread (requirements 2.2). A report keeps its original Message-ID.
    if (classification.automated)
      return finish(patch, { ...base, outcome: "automated", reason: classification.signs.join(",") })

    const sender = msg.fromAddress
    let links: Thread[] = []
    let linkReason: TicketFlag | null = null
    if (match.kind === "thread") {
      const store = storeOf(match.thread.kind)
      const thread = match.thread.id
      if (sender !== null && (await store.isParticipant(tx, thread, sender))) {
        await store.joined(tx, thread)
        await this.#keepPending(tx, store, msg, thread)
        // Only the thread the message joined stops waiting for it (review G3).
        if (msg.messageIdHeader) await store.resolvePending(tx, thread, msg.messageIdHeader, msg.id)
        return finish(
          { ...patch, ...store.messageColumn(thread) },
          { ...base, ...store.recordThread(thread), outcome: "joined" },
        )
      }
      // Every layer is only a hint: a sender who is not a participant opens a new thread, linked to the old one.
      links = [match.thread]
      linkReason = "sender_not_participant"
    } else if (match.kind === "ambiguous") {
      // A late original that more than one thread waits for: its own thread, linked to each, never one at random.
      links = match.holders
      linkReason = "ambiguous_original"
    }

    const outcome: IntakeOutcome = linkReason ? "new_linked_ticket" : "new_ticket"
    if (!address) {
      flags.add("no_default_address" satisfies MessageFlag)
      return finish(patch, { ...base, outcome: "no_address", reason: linkReason ?? "no_default_address" })
    }
    const threadFlags: TicketFlag[] = []
    if (classification.possiblyAutomated) threadFlags.push("possibly_automated")
    if (linkReason) threadFlags.push(linkReason)
    const opened = await opens.open(tx, {
      organizationId: address.organizationId,
      supportAddress: address.supportAddress,
      subject: msg.subject,
      flags: threadFlags,
    })
    // Participants: From, and Cc addresses that are not support addresses.
    if (msg.fromAddress) await opens.addParticipant(tx, opened, msg.fromAddress, msg.fromName)
    for (const entry of cc)
      if (entry.address !== msg.fromAddress && !matchSupportAddress(entry.address, rules))
        await opens.addParticipant(tx, opened, entry.address, entry.name)
    // Links join threads of one kind; a listening conversation names the ticket it matched in its record.
    for (const linked of links.filter((thread) => thread.kind === opens.kind))
      await opens.link(tx, opened, linked.id, linkReason ?? "sender_not_participant")
    await this.#keepPending(tx, opens, msg, opened)
    const firstTicket = links.find((thread) => thread.kind === "ticket")
    return finish(
      { ...patch, ...opens.messageColumn(opened) },
      {
        ...base,
        ...(firstTicket && !live ? { matchedTicketId: firstTicket.id } : {}),
        ...opens.recordThread(opened),
        outcome,
        reason: linkReason,
      },
    )
  }

  /** The threading layers, in order, over every store the mode matches (requirements 2.2, P6, P7). */
  async #match(tx: Tx, stores: ThreadStore[], msg: MessageRow): Promise<Match> {
    const all = async (find: (store: ThreadStore) => Promise<string[]>) =>
      (
        await Promise.all(stores.map(async (store) => (await find(store)).map((id) => ({ kind: store.kind, id }))))
      ).flat()
    for (const id of referencedIds(msg.inReplyTo, msg.references)) {
      const byMessage = await all((store) => store.threadsOf(tx, id))
      // A Message-ID on messages of more than one thread is ambiguous and matches nothing in this layer (P7).
      if (byMessage.length > 1) continue
      const threads = new Map<string, Thread>()
      for (const thread of [...byMessage, ...(await all((store) => store.waitingFor(tx, id)))])
        threads.set(key(thread), thread)
      const [only] = threads.values()
      if (threads.size === 1 && only) return { kind: "thread", thread: only, layer: "header" }
    }
    // A late original: the threads whose messages referred to it while it was missing (P6).
    if (msg.messageIdHeader) {
      const id = msg.messageIdHeader
      const holders = await all((store) => store.waitingFor(tx, id))
      const [only] = holders
      if (holders.length === 1 && only) return { kind: "thread", thread: only, layer: "original" }
      if (holders.length > 1) return { kind: "ambiguous", holders, layer: "original" }
    }
    // The body reference code and the subject number (review G12: the first few, in one query each).
    const codes = referenceCodesIn(msg.textBody)
    const numbers = ticketNumbersIn(msg.subject)
    for (const store of stores) {
      const found = codes.length ? await store.byReferenceCodes(tx, codes) : null
      if (found) return { kind: "thread", thread: { kind: store.kind, id: found }, layer: "reference" }
    }
    for (const store of stores) {
      const found = numbers.length ? await store.byNumbers(tx, numbers) : null
      if (found) return { kind: "thread", thread: { kind: store.kind, id: found }, layer: "subject" }
    }
    return { kind: "none" }
  }

  /** Each Message-ID the message refers to that no processed message carries waits on the thread (P6). */
  async #keepPending(tx: Tx, store: ThreadStore, msg: MessageRow, thread: string): Promise<void> {
    const ids = referencedIds(msg.inReplyTo, msg.references).filter((id) => id !== msg.messageIdHeader)
    if (ids.length === 0) return
    const known = await tx
      .selectDistinct({ id: message.messageIdHeader })
      .from(message)
      .where(and(inArray(message.messageIdHeader, ids), eq(message.state, "processed"), eq(message.content, "parsed")))
    const present = new Set(known.map((row) => row.id))
    await store.keepPending(
      tx,
      thread,
      ids.filter((candidate) => !present.has(candidate)),
    )
  }

  /**
   * Tickets. Read only (listening): matched, never changed; a message that would join one names it in
   * `would_ticket_id`, which later listening replies match like a ticket's own messages.
   */
  #ticketStore(readOnly: boolean): ThreadStore {
    const now = () => this.#now()
    const ticketOfMessage = sql<string>`coalesce(${message.ticketId}, ${message.wouldTicketId})`
    return {
      kind: "ticket",
      async threadsOf(tx, id) {
        const rows = await tx
          .selectDistinct({ thread: ticketOfMessage })
          .from(message)
          .where(
            and(
              eq(message.messageIdHeader, id),
              or(isNotNull(message.ticketId), isNotNull(message.wouldTicketId)),
              eq(message.content, "parsed"),
            ),
          )
        return rows.map((row) => row.thread)
      },
      async waitingFor(tx, id) {
        const rows = await tx
          .select({ thread: ticketPendingReference.ticketId })
          .from(ticketPendingReference)
          .where(and(eq(ticketPendingReference.messageIdHeader, id), isNull(ticketPendingReference.resolvedBy)))
          .orderBy(asc(ticketPendingReference.createdAt))
        return rows.map((row) => row.thread)
      },
      async byReferenceCodes(tx, codes) {
        const rows = await tx
          .select({ id: ticket.id, code: ticket.referenceCode })
          .from(ticket)
          .where(inArray(ticket.referenceCode, codes))
        return firstFound(codes, new Map(rows.map((row) => [row.code, row.id])))
      },
      async byNumbers(tx, numbers) {
        const rows = await tx
          .select({ id: ticket.id, number: ticket.number })
          .from(ticket)
          .where(inArray(ticket.number, numbers))
        return firstFound(numbers, new Map(rows.map((row) => [row.number, row.id])))
      },
      async isParticipant(tx, thread, address) {
        const rows = await tx
          .select({ address: ticketParticipant.address })
          .from(ticketParticipant)
          .where(and(eq(ticketParticipant.ticketId, thread), eq(ticketParticipant.address, address)))
        return rows.length > 0
      },
      // A number from the sequence, a reference code from the CSPRNG (drawn again on the rare collision).
      async open(tx, values) {
        if (readOnly) throw new Error("listening mode opens no ticket")
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
              createdAt: now(),
              lastActivityAt: now(),
            })
            .onConflictDoNothing({ target: ticket.referenceCode })
            .returning({ id: ticket.id })
          if (row) return row.id
        }
        throw new Error("no free reference code after 8 draws")
      },
      async addParticipant(tx, thread, address, name) {
        if (!readOnly)
          await tx.insert(ticketParticipant).values({ ticketId: thread, address, name }).onConflictDoNothing()
      },
      async link(tx, thread, linked, reason) {
        if (!readOnly)
          await tx.insert(ticketLink).values({ ticketId: thread, linkedTicketId: linked, reason }).onConflictDoNothing()
      },
      async joined(tx, thread) {
        if (!readOnly)
          await tx.update(ticket).set({ status: "open", lastActivityAt: now() }).where(eq(ticket.id, thread))
      },
      async keepPending(tx, thread, ids) {
        if (!readOnly && ids.length)
          await tx
            .insert(ticketPendingReference)
            .values(ids.map((id) => ({ ticketId: thread, messageIdHeader: id })))
            .onConflictDoNothing()
      },
      async resolvePending(tx, thread, id, by) {
        if (readOnly) return
        await tx
          .update(ticketPendingReference)
          .set({ resolvedBy: by })
          .where(
            and(
              eq(ticketPendingReference.ticketId, thread),
              eq(ticketPendingReference.messageIdHeader, id),
              isNull(ticketPendingReference.resolvedBy),
            ),
          )
      },
      messageColumn: (thread) => (readOnly ? { wouldTicketId: thread } : { ticketId: thread }),
      recordThread: (thread) => (readOnly ? { matchedTicketId: thread } : { ticketId: thread }),
      recordMatched: (thread) => ({ matchedTicketId: thread }),
    }
  }

  #conversationStore(): ThreadStore {
    return {
      kind: "conversation",
      async threadsOf(tx, id) {
        const rows = await tx
          .selectDistinct({ thread: message.conversationId })
          .from(message)
          .where(and(eq(message.messageIdHeader, id), isNotNull(message.conversationId), eq(message.content, "parsed")))
        return rows.map((row) => row.thread).filter((thread): thread is string => thread !== null)
      },
      async waitingFor(tx, id) {
        const rows = await tx
          .select({ thread: intakeConversationPending.conversationId })
          .from(intakeConversationPending)
          .where(and(eq(intakeConversationPending.messageIdHeader, id), isNull(intakeConversationPending.resolvedBy)))
          .orderBy(asc(intakeConversationPending.createdAt))
        return rows.map((row) => row.thread)
      },
      // Conversations have no reference code and no number: Maane sends nothing while it listens.
      byReferenceCodes: async () => null,
      byNumbers: async () => null,
      async isParticipant(tx, thread, address) {
        const rows = await tx
          .select({ address: intakeConversationParticipant.address })
          .from(intakeConversationParticipant)
          .where(
            and(
              eq(intakeConversationParticipant.conversationId, thread),
              eq(intakeConversationParticipant.address, address),
            ),
          )
        return rows.length > 0
      },
      async open(tx, values) {
        const [row] = await tx
          .insert(intakeConversation)
          .values({
            organizationId: values.organizationId,
            supportAddress: values.supportAddress,
            reviewFlags: values.flags,
          })
          .returning({ id: intakeConversation.id })
        if (!row) throw new Error("the conversation was not written")
        return row.id
      },
      async addParticipant(tx, thread, address, name) {
        await tx
          .insert(intakeConversationParticipant)
          .values({ conversationId: thread, address, name })
          .onConflictDoNothing()
      },
      async link(tx, thread, linked, reason) {
        await tx
          .insert(intakeConversationLink)
          .values({ conversationId: thread, linkedConversationId: linked, reason })
          .onConflictDoNothing()
      },
      joined: async () => undefined,
      async keepPending(tx, thread, ids) {
        if (ids.length)
          await tx
            .insert(intakeConversationPending)
            .values(ids.map((id) => ({ conversationId: thread, messageIdHeader: id })))
            .onConflictDoNothing()
      },
      async resolvePending(tx, thread, id, by) {
        await tx
          .update(intakeConversationPending)
          .set({ resolvedBy: by })
          .where(
            and(
              eq(intakeConversationPending.conversationId, thread),
              eq(intakeConversationPending.messageIdHeader, id),
              isNull(intakeConversationPending.resolvedBy),
            ),
          )
      },
      messageColumn: (thread) => ({ conversationId: thread }),
      recordThread: (thread) => ({ conversationId: thread }),
      recordMatched: (thread) => ({ matchedConversationId: thread }),
    }
  }
}
