// Stage two of intake (plan 2.3, P6, P7, P8, P11, P16): processes stored messages, oldest first by Graph's receive
// time, each in its own transaction, idempotent by the message's state. Each transaction first locks the intake.mode
// row FOR SHARE and reads it, so a switch (which updates that row) waits until every transaction that read the old mode
// committed, and no transaction that starts after the switch reads the old mode. Messages already stored are processed
// whatever the current source is: they are mail that really arrived, and the mode at processing time decides. A
// message waits while one of its text fields waits for the scanner (content.ts).
//
// For each message: a copy of an earlier one is recorded and changes nothing; automated mail opens, joins, and reopens
// nothing; otherwise the support address (To, then Cc, then the default) and the threading layers decide between
// joining a thread, a new thread, and a new thread linked to the ones it matched. One decision path serves both modes
// over two stores (review G4): live mode keeps tickets; listening mode keeps shadow conversations (no number, no
// reference code, no status) with the same participants, links, and pending references, so a listening record says
// exactly what live mode would have done.

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
import { and, asc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm"
import type { Tx } from "../files/types.ts"
import { classify } from "./classify.ts"
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

type Match =
  | { kind: "thread"; threadId: string; layer: MatchLayer }
  | { kind: "ambiguous"; threadIds: string[]; layer: "original" }
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

/**
 * Where threads live: tickets (live) or shadow conversations (listening). The decision path is the same for both; only
 * tickets have numbers and reference codes, so the body-code and subject layers match tickets only.
 */
interface ThreadStore {
  /** The threads of parsed messages carrying this Message-ID. */
  threadsOf(tx: Tx, id: string): Promise<string[]>
  /** The threads still waiting for this Message-ID, oldest first. */
  waitingFor(tx: Tx, id: string): Promise<string[]>
  byReferenceCode(tx: Tx, code: string): Promise<string | null>
  byNumber(tx: Tx, number: number): Promise<string | null>
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
  /** The message's own column and the record's columns for a thread it belongs to or matched. */
  messageColumn(thread: string): Partial<MessageRow>
  recordColumns(thread: string | null, matched: string | null): Partial<RecordFields>
}

export class IntakeProcessor {
  readonly #db: Db
  readonly #now: () => Date
  readonly #tickets: ThreadStore
  readonly #conversations: ThreadStore

  constructor(options: { db: Db; now?: () => Date }) {
    this.#db = options.db
    this.#now = options.now ?? (() => new Date())
    this.#tickets = this.#ticketStore()
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
      const [next] = await this.#db
        .select({ id: message.id, attempts: message.processAttempts })
        .from(message)
        .where(
          and(
            eq(message.state, "stored"),
            sql`not ${FIELDS_WAITING}`,
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
    const store = live ? this.#tickets : this.#conversations
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

    const headers = Array.isArray(msg.headers) ? (msg.headers as { key: string; line: string }[]) : []
    const contentType = (msg.contentType as StoredContentType | null) ?? { value: "text/plain", reportType: null }
    const classification = classify({ headers, contentType, from: msg.fromAddress })
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

    const match = await this.#match(tx, store, msg)
    const matched = match.kind === "thread" ? match.threadId : null
    const base: RecordFields = {
      outcome: "new_ticket",
      classification: classification.automated ? "automated" : "customer",
      supportAddress: address?.supportAddress ?? null,
      organizationId: address?.organizationId ?? null,
      ...store.recordColumns(null, matched),
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
    let links: string[] = []
    let linkReason: TicketFlag | null = null
    if (match.kind === "thread") {
      if (sender !== null && (await store.isParticipant(tx, match.threadId, sender))) {
        await store.joined(tx, match.threadId)
        await this.#keepPending(tx, store, msg, match.threadId)
        // Only the thread the message joined stops waiting for it (review G3).
        if (msg.messageIdHeader) await store.resolvePending(tx, match.threadId, msg.messageIdHeader, msg.id)
        return finish(
          { ...patch, ...store.messageColumn(match.threadId) },
          { ...base, ...store.recordColumns(match.threadId, match.threadId), outcome: "joined" },
        )
      }
      // Every layer is only a hint: a sender who is not a participant opens a new thread, linked to the old one.
      links = [match.threadId]
      linkReason = "sender_not_participant"
    } else if (match.kind === "ambiguous") {
      // A late original that more than one thread waits for: its own thread, linked to each, never one at random.
      links = match.threadIds
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
    const opened = await store.open(tx, {
      organizationId: address.organizationId,
      supportAddress: address.supportAddress,
      subject: msg.subject,
      flags: threadFlags,
    })
    // Participants: From, and Cc addresses that are not support addresses.
    if (msg.fromAddress) await store.addParticipant(tx, opened, msg.fromAddress, msg.fromName)
    for (const entry of cc)
      if (entry.address !== msg.fromAddress && !matchSupportAddress(entry.address, rules))
        await store.addParticipant(tx, opened, entry.address, entry.name)
    for (const linked of links) await store.link(tx, opened, linked, linkReason ?? "sender_not_participant")
    await this.#keepPending(tx, store, msg, opened)
    return finish(
      { ...patch, ...store.messageColumn(opened) },
      { ...base, ...store.recordColumns(opened, matched), outcome, reason: linkReason },
    )
  }

  /** The threading layers, in order (requirements 2.2, P6, P7). */
  async #match(tx: Tx, store: ThreadStore, msg: MessageRow): Promise<Match> {
    for (const id of referencedIds(msg.inReplyTo, msg.references)) {
      const byMessage = await store.threadsOf(tx, id)
      // A Message-ID on messages of more than one thread is ambiguous and matches nothing in this layer (P7).
      if (byMessage.length > 1) continue
      const threads = new Set([...byMessage, ...(await store.waitingFor(tx, id))])
      const [only] = threads
      if (threads.size === 1 && only) return { kind: "thread", threadId: only, layer: "header" }
    }
    // A late original: the threads whose messages referred to it while it was missing (P6).
    if (msg.messageIdHeader) {
      const holders = await store.waitingFor(tx, msg.messageIdHeader)
      const [only] = holders
      if (holders.length === 1 && only) return { kind: "thread", threadId: only, layer: "original" }
      if (holders.length > 1) return { kind: "ambiguous", threadIds: holders, layer: "original" }
    }
    for (const code of referenceCodesIn(msg.textBody)) {
      const found = await store.byReferenceCode(tx, code)
      if (found) return { kind: "thread", threadId: found, layer: "reference" }
    }
    for (const number of ticketNumbersIn(msg.subject)) {
      const found = await store.byNumber(tx, number)
      if (found) return { kind: "thread", threadId: found, layer: "subject" }
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

  #ticketStore(): ThreadStore {
    const now = () => this.#now()
    return {
      async threadsOf(tx, id) {
        const rows = await tx
          .selectDistinct({ thread: message.ticketId })
          .from(message)
          .where(and(eq(message.messageIdHeader, id), isNotNull(message.ticketId), eq(message.content, "parsed")))
        return rows.map((row) => row.thread).filter((thread): thread is string => thread !== null)
      },
      async waitingFor(tx, id) {
        const rows = await tx
          .select({ thread: ticketPendingReference.ticketId })
          .from(ticketPendingReference)
          .where(and(eq(ticketPendingReference.messageIdHeader, id), isNull(ticketPendingReference.resolvedBy)))
          .orderBy(asc(ticketPendingReference.createdAt))
        return rows.map((row) => row.thread)
      },
      async byReferenceCode(tx, code) {
        const [row] = await tx.select({ id: ticket.id }).from(ticket).where(eq(ticket.referenceCode, code))
        return row?.id ?? null
      },
      async byNumber(tx, number) {
        const [row] = await tx.select({ id: ticket.id }).from(ticket).where(eq(ticket.number, number))
        return row?.id ?? null
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
        await tx.insert(ticketParticipant).values({ ticketId: thread, address, name }).onConflictDoNothing()
      },
      async link(tx, thread, linked, reason) {
        await tx.insert(ticketLink).values({ ticketId: thread, linkedTicketId: linked, reason }).onConflictDoNothing()
      },
      async joined(tx, thread) {
        await tx.update(ticket).set({ status: "open", lastActivityAt: now() }).where(eq(ticket.id, thread))
      },
      async keepPending(tx, thread, ids) {
        if (ids.length)
          await tx
            .insert(ticketPendingReference)
            .values(ids.map((id) => ({ ticketId: thread, messageIdHeader: id })))
            .onConflictDoNothing()
      },
      async resolvePending(tx, thread, id, by) {
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
      messageColumn: (thread) => ({ ticketId: thread }),
      recordColumns: (thread, matched) => ({ ticketId: thread, matchedTicketId: matched }),
    }
  }

  #conversationStore(): ThreadStore {
    return {
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
      byReferenceCode: async () => null,
      byNumber: async () => null,
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
      recordColumns: (thread, matched) => ({ conversationId: thread, matchedConversationId: matched }),
    }
  }
}
