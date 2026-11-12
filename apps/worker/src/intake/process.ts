// Stage two of intake (plan 2.3, P6, P7, P8, P11, P16): processes stored messages, oldest first by Graph's receive
// time, each in its own transaction, idempotent by the message's state. Each transaction first locks the intake.mode
// row FOR SHARE and reads it, so a switch (which updates that row) waits until every transaction that read the old mode
// committed, and no transaction that starts after the switch reads the old mode. Messages already stored are processed
// whatever the current source is: they are mail that really arrived, and the mode at processing time decides.
//
// For each message: a copy of an earlier one is recorded and changes nothing; automated mail opens, joins, and reopens
// nothing; otherwise the support address (To, then Cc, then the default) and the threading layers (headers with the
// pending references of missing originals, a late original, the body reference code, the subject number) decide
// between joining a ticket, a new ticket, and a new ticket linked to the ones it matched. Live mode does it; listening
// mode records what it would have done and opens no ticket and takes no number.

import type { Db } from "@maane/server/db/client"
import {
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
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm"
import type { Tx } from "../files/types.ts"
import { classify, contentTypeOf } from "./classify.ts"
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

type Match =
  | { kind: "ticket"; ticketId: string; layer: MatchLayer }
  | { kind: "ambiguous"; ticketIds: string[]; layer: "original" }
  | { kind: "message"; messageId: string; layer: "header" | "original" }
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

export class IntakeProcessor {
  readonly #db: Db
  readonly #now: () => Date

  constructor(options: { db: Db; now?: () => Date }) {
    this.#db = options.db
    this.#now = options.now ?? (() => new Date())
  }

  /**
   * Processes stored messages, oldest first. A message whose transaction fails stays stored and is skipped for the
   * rest of this run, so one bad message cannot stop the others.
   */
  async run(hooks: ProcessHooks = {}, limit = MAX_PER_RUN): Promise<{ processed: number; failed: number }> {
    const failed: string[] = []
    let processed = 0
    while (processed + failed.length < limit) {
      const [next] = await this.#db
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.state, "stored"), failed.length ? notInArray(message.id, failed) : undefined))
        .orderBy(asc(message.receivedAt), asc(message.createdAt), asc(message.id))
        .limit(1)
      if (!next) break
      try {
        await this.processOne(next.id, hooks)
        processed++
      } catch (error) {
        if (/^(22|54)/.test(databaseError(error)?.code ?? "") && (await this.#refused(next.id))) {
          log.warn(
            "the database refused a value of a message's processing; it is recorded for review",
            errorFacts(error),
          )
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

  /** A message whose processing the database refused: processed without a ticket, flagged, and recorded. */
  async #refused(id: string): Promise<boolean> {
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
      await tx.insert(intakeRecord).values({ messageId: id, mode, outcome: "unreadable", reason: "store_failed" })
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

    const headers = Array.isArray(msg.headers) ? (msg.headers as { key: string; line: string }[]) : []
    const classification = classify({ headers, contentType: contentTypeOf(headers), from: msg.fromAddress })
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

    let match = await this.#matchTicket(tx, msg)
    if (match.kind === "none" && !live) match = await this.#matchMessage(tx, msg)
    const base: RecordFields = {
      outcome: "new_ticket",
      classification: classification.automated ? "automated" : "customer",
      supportAddress: address?.supportAddress ?? null,
      organizationId: address?.organizationId ?? null,
      matchedTicketId: match.kind === "ticket" ? match.ticketId : null,
      matchedMessageId: match.kind === "message" ? match.messageId : null,
      matchLayer: match.kind === "none" ? null : match.layer,
    }
    const patch: Partial<MessageRow> = {
      classification: base.classification,
      automatedReasons: classification.signs,
    }

    // Automated mail never opens, joins, or reopens a ticket (requirements 2.2). A report keeps its original Message-ID.
    if (classification.automated)
      return finish(patch, { ...base, outcome: "automated", reason: classification.signs.join(",") })

    const sender = msg.fromAddress
    let links: string[] = []
    let linkReason: TicketFlag | null = null
    if (match.kind === "ticket" || match.kind === "message") {
      const participant =
        sender !== null &&
        (match.kind === "ticket"
          ? await this.#isParticipant(tx, match.ticketId, sender)
          : await this.#isConversationParticipant(tx, match.messageId, sender, rules))
      if (participant) {
        if (live && match.kind === "ticket") await this.#join(tx, msg, match.ticketId)
        return finish(live && match.kind === "ticket" ? { ...patch, ticketId: match.ticketId } : patch, {
          ...base,
          outcome: "joined",
          ticketId: live && match.kind === "ticket" ? match.ticketId : null,
        })
      }
      // Every layer is only a hint: a sender who is not a participant opens a new ticket, linked to the old one.
      links = match.kind === "ticket" ? [match.ticketId] : []
      linkReason = "sender_not_participant"
    } else if (match.kind === "ambiguous") {
      // A late original that more than one ticket waits for: its own ticket, linked to each, never one at random.
      links = match.ticketIds
      linkReason = "ambiguous_original"
    }

    const outcome: IntakeOutcome = linkReason ? "new_linked_ticket" : "new_ticket"
    if (!address) {
      flags.add("no_default_address" satisfies MessageFlag)
      return finish(patch, { ...base, outcome: "no_address", reason: linkReason ?? "no_default_address" })
    }
    if (!live) return finish(patch, { ...base, outcome, reason: linkReason })

    const ticketFlags: TicketFlag[] = []
    if (classification.possiblyAutomated) ticketFlags.push("possibly_automated")
    if (linkReason) ticketFlags.push(linkReason)
    const opened = await this.#openTicket(tx, msg, address, ticketFlags, rules, cc)
    for (const linked of links)
      await tx
        .insert(ticketLink)
        .values({ ticketId: opened, linkedTicketId: linked, reason: linkReason ?? "sender_not_participant" })
        .onConflictDoNothing()
    await this.#keepPendingReferences(tx, msg, opened)
    await this.#resolvePending(tx, msg)
    return finish({ ...patch, ticketId: opened }, { ...base, outcome, ticketId: opened, reason: linkReason })
  }

  /** The threading layers against tickets, in order (requirements 2.2, P6, P7). */
  async #matchTicket(tx: Tx, msg: MessageRow): Promise<Match> {
    for (const id of referencedIds(msg.inReplyTo, msg.references)) {
      const byMessage = await tx
        .selectDistinct({ ticketId: message.ticketId })
        .from(message)
        .where(and(eq(message.messageIdHeader, id), isNotNull(message.ticketId), eq(message.content, "parsed")))
      // A Message-ID on messages of more than one ticket is ambiguous and matches nothing in this layer (P7).
      if (byMessage.length > 1) continue
      const byPending = await tx
        .select({ ticketId: ticketPendingReference.ticketId })
        .from(ticketPendingReference)
        .where(and(eq(ticketPendingReference.messageIdHeader, id), isNull(ticketPendingReference.resolvedBy)))
      const tickets = new Set([...byMessage, ...byPending].map((row) => row.ticketId).filter((t) => t !== null))
      const [only] = tickets
      if (tickets.size === 1 && only) return { kind: "ticket", ticketId: only, layer: "header" }
    }
    // A late original: the tickets whose messages referred to it while it was missing (P6).
    if (msg.messageIdHeader) {
      const holders = await tx
        .select({ ticketId: ticketPendingReference.ticketId })
        .from(ticketPendingReference)
        .where(
          and(
            eq(ticketPendingReference.messageIdHeader, msg.messageIdHeader),
            isNull(ticketPendingReference.resolvedBy),
          ),
        )
        .orderBy(asc(ticketPendingReference.createdAt))
      const [only] = holders
      if (holders.length === 1 && only) return { kind: "ticket", ticketId: only.ticketId, layer: "original" }
      if (holders.length > 1)
        return { kind: "ambiguous", ticketIds: holders.map((holder) => holder.ticketId), layer: "original" }
    }
    for (const code of referenceCodesIn(msg.textBody)) {
      const [found] = await tx.select({ id: ticket.id }).from(ticket).where(eq(ticket.referenceCode, code))
      if (found) return { kind: "ticket", ticketId: found.id, layer: "reference" }
    }
    for (const number of ticketNumbersIn(msg.subject)) {
      const [found] = await tx.select({ id: ticket.id }).from(ticket).where(eq(ticket.number, number))
      if (found) return { kind: "ticket", ticketId: found.id, layer: "subject" }
    }
    return { kind: "none" }
  }

  /**
   * Listening mode has no tickets of its own: the earlier message whose conversation this one would join, by its
   * headers, or, for a late original, the earliest message that referred to it.
   */
  async #matchMessage(tx: Tx, msg: MessageRow): Promise<Match> {
    const processed = and(eq(message.state, "processed"), eq(message.content, "parsed"), isNull(message.duplicateOf))
    for (const id of referencedIds(msg.inReplyTo, msg.references)) {
      const [found] = await tx
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.messageIdHeader, id), processed))
        .orderBy(desc(message.receivedAt))
        .limit(1)
      if (found) return { kind: "message", messageId: found.id, layer: "header" }
    }
    if (msg.messageIdHeader) {
      const [found] = await tx
        .select({ id: message.id })
        .from(message)
        .where(
          and(
            processed,
            sql`(${msg.messageIdHeader} = any(${message.inReplyTo}) or ${msg.messageIdHeader} = any(${message.references}))`,
          ),
        )
        .orderBy(asc(message.receivedAt))
        .limit(1)
      if (found) return { kind: "message", messageId: found.id, layer: "original" }
    }
    return { kind: "none" }
  }

  async #isParticipant(tx: Tx, ticketId: string, address: string): Promise<boolean> {
    const rows = await tx
      .select({ address: ticketParticipant.address })
      .from(ticketParticipant)
      .where(and(eq(ticketParticipant.ticketId, ticketId), eq(ticketParticipant.address, address)))
    return rows.length > 0
  }

  /** Listening: the people a ticket opened by that message would have had (its sender and its non-support Cc). */
  async #isConversationParticipant(tx: Tx, messageId: string, address: string, rules: Rule[]): Promise<boolean> {
    const [row] = await tx
      .select({ fromAddress: message.fromAddress, cc: message.ccAddresses })
      .from(message)
      .where(eq(message.id, messageId))
    if (!row) return false
    if (row.fromAddress === address) return true
    return addressesOf(row.cc).some((entry) => entry.address === address && !matchSupportAddress(entry.address, rules))
  }

  /** A customer message on an existing ticket: it joins, and the ticket becomes `open`. */
  async #join(tx: Tx, msg: MessageRow, ticketId: string): Promise<void> {
    await tx.update(ticket).set({ status: "open", lastActivityAt: this.#now() }).where(eq(ticket.id, ticketId))
    await this.#keepPendingReferences(tx, msg, ticketId)
    await this.#resolvePending(tx, msg)
  }

  /**
   * A new ticket: a number from the sequence, a reference code from the CSPRNG (drawn again on the rare collision),
   * the concrete support address and organization, and its participants (From, and Cc that are not support addresses).
   */
  async #openTicket(
    tx: Tx,
    msg: MessageRow,
    address: { supportAddress: string; organizationId: string },
    flags: TicketFlag[],
    rules: Rule[],
    cc: MailAddress[],
  ): Promise<string> {
    let opened: string | undefined
    for (let attempt = 0; attempt < 8 && !opened; attempt++) {
      const [row] = await tx
        .insert(ticket)
        .values({
          referenceCode: newReferenceCode(),
          organizationId: address.organizationId,
          supportAddress: address.supportAddress,
          subject: msg.subject,
          status: "new",
          reviewFlags: flags,
          createdAt: this.#now(),
          lastActivityAt: this.#now(),
        })
        .onConflictDoNothing({ target: ticket.referenceCode })
        .returning({ id: ticket.id })
      opened = row?.id
    }
    if (!opened) throw new Error("no free reference code after 8 draws")
    const people = new Map<string, string | null>()
    if (msg.fromAddress) people.set(msg.fromAddress, msg.fromName)
    for (const entry of cc)
      if (!people.has(entry.address) && !matchSupportAddress(entry.address, rules))
        people.set(entry.address, entry.name)
    for (const [participant, name] of people)
      await tx.insert(ticketParticipant).values({ ticketId: opened, address: participant, name }).onConflictDoNothing()
    return opened
  }

  /** Each Message-ID the message refers to that no processed message carries waits on the ticket (P6). */
  async #keepPendingReferences(tx: Tx, msg: MessageRow, ticketId: string): Promise<void> {
    const ids = referencedIds(msg.inReplyTo, msg.references).filter((id) => id !== msg.messageIdHeader)
    if (ids.length === 0) return
    const known = await tx
      .selectDistinct({ id: message.messageIdHeader })
      .from(message)
      .where(and(inArray(message.messageIdHeader, ids), eq(message.state, "processed"), eq(message.content, "parsed")))
    const present = new Set(known.map((row) => row.id))
    for (const id of ids.filter((candidate) => !present.has(candidate)))
      await tx.insert(ticketPendingReference).values({ ticketId, messageIdHeader: id }).onConflictDoNothing()
  }

  /** The original arrived: the references that waited for it are resolved by it. */
  async #resolvePending(tx: Tx, msg: MessageRow): Promise<void> {
    if (!msg.messageIdHeader) return
    await tx
      .update(ticketPendingReference)
      .set({ resolvedBy: msg.id })
      .where(
        and(eq(ticketPendingReference.messageIdHeader, msg.messageIdHeader), isNull(ticketPendingReference.resolvedBy)),
      )
  }
}
