// Sending a reply (plan 3.1), the `send-reply` job. The outbox row, not the queue, decides whether anything may go:
//
// 1. One transaction locks the intake mode (FOR SHARE) and the outbox row (FOR UPDATE). A row that is `sending` was
//    left by a run that stopped halfway (a crash, or pg-boss expired the job while its handler still ran): it may have
//    been sent, so every recipient not accepted becomes `unknown` and nothing is sent. Only a `pending` row goes on.
//    The send point checks again what the server checked when the agent wrote the reply: intake is live, the From
//    address still belongs to the ticket's organization, and the author may still answer the ticket. Then the row
//    becomes `sending` and the transaction commits, before the first byte leaves.
//    The claim gives the attempt an ID of its own (outbox.attempt). Every later step goes on only while the row is
//    still `sending` under that ID, checked under the row's lock: right before each send, and with each result. An
//    attempt another run made stale (marked unknown, sent again) stops there, without sending or writing.
// 2. SMTP2GO, then the failover server, each through one attempt (smtp.ts). The failover gets only what SMTP2GO did
//    not take for certain: everything when SMTP2GO could not be reached or logged in to, the refused recipients when it
//    refused some. An unknown outcome ends the attempt there: nothing goes to the failover.
// 3. Each provider's answer is stored per recipient; a recipient it accepted becomes a participant of the ticket. The
//    row's state then follows its recipients (OUTBOX_STATES).

import { randomUUID } from "node:crypto"
import { SYSTEM, writeAudit } from "@maane/server/audit"
import type { Db } from "@maane/server/db/client"
import { authUser, message, outbox, outboxRecipient, ticket, ticketParticipant } from "@maane/server/db/schema"
import { queueIdOf, refreshDeliveryFlag } from "@maane/server/delivery/service"
import { errorFacts, log } from "@maane/server/log"
import { inScope, visibleOrganizations } from "@maane/server/organizations/scope"
import { belongsTo, supportRules } from "@maane/server/replies/rules"
import type { Settings } from "@maane/server/settings/service"
import { type OutboxState, outboxStateOf, PROVIDERS, type SendProblem } from "@maane/shared"
import { and, eq, inArray, ne, sql } from "drizzle-orm"
import type { Tx } from "../files/types.ts"
import { lockIntakeMode } from "../intake/process.ts"
import { type Delivery, deliver, SMTP_TIMEOUTS, type SmtpConfig, type SmtpTimeouts, smtpConfig } from "./smtp.ts"

export interface ReplySenderOptions {
  db: Db
  settings: Settings
  timeouts?: SmtpTimeouts
  /** Called right after the attempt was committed as `sending`, before anything is sent: a test stops a run here. */
  afterClaim?: (messageId: string) => Promise<void>
  now?: () => Date
}

type Claim = {
  /** This attempt's ID: the row is this attempt's while outbox.attempt holds it. */
  attempt: string
  mime: Buffer
  from: string
  ticketId: string
  recipients: { address: string; name: string | null }[]
}

export class ReplySender {
  readonly #db: Db
  readonly #settings: Settings
  readonly #timeouts: SmtpTimeouts
  readonly #afterClaim?: (messageId: string) => Promise<void>
  readonly #now: () => Date

  constructor(options: ReplySenderOptions) {
    this.#db = options.db
    this.#settings = options.settings
    this.#timeouts = options.timeouts ?? SMTP_TIMEOUTS
    this.#afterClaim = options.afterClaim
    this.#now = options.now ?? (() => new Date())
  }

  /** Sends one reply as far as its outbox row allows; returns the row's state afterwards. */
  async send(messageId: string): Promise<OutboxState | null> {
    const claim = await this.#claim(messageId)
    if (!claim) return this.#state(messageId)
    await this.#afterClaim?.(messageId)

    const configs: SmtpConfig[] = []
    for (const provider of PROVIDERS) {
      const config = await smtpConfig(this.#settings, provider)
      if (config) configs.push(config)
    }
    const bounce = await this.#settings.get("mail.bounceAddress")
    let remaining = claim.recipients.map((entry) => entry.address)
    for (const config of configs) {
      if (remaining.length === 0) break
      // The failover's envelope sender is the bounce address, which reaches intake; SMTP2GO handles its own bounces.
      const from = config.provider === "failover" && bounce ? bounce : claim.from
      // Still this attempt's, right before the bytes leave: a stale attempt sends nothing.
      if (!(await this.#db.transaction((tx) => this.#owns(tx, messageId, claim.attempt)))) return this.#stale(messageId)
      const result = await deliver(config, { from, to: remaining }, claim.mime, this.#timeouts)
      if (!(await this.#record(messageId, claim, config, result))) return this.#stale(messageId)
      if (result.kind === "unknown") break
      if (result.kind === "answered") remaining = result.refused.map((entry) => entry.address)
    }
    return this.#finish(messageId, claim.attempt, configs.length > 0)
  }

  /** Whether the row is still `sending` under this attempt, locked until the transaction ends. */
  async #owns(tx: Tx, messageId: string, attempt: string): Promise<boolean> {
    const [row] = await tx
      .select({ state: outbox.state, attempt: outbox.attempt })
      .from(outbox)
      .where(eq(outbox.messageId, messageId))
      .for("update")
    return row?.state === "sending" && row.attempt === attempt
  }

  /** An attempt another run made stale stops here: it sends nothing more and writes nothing. */
  async #stale(messageId: string): Promise<OutboxState | null> {
    log.warn("a reply's attempt is no longer current; it stops without sending or writing", { messageId })
    return this.#state(messageId)
  }

  /** Step 1: the checks and the claim, committed before anything is sent. Null when nothing may be sent now. */
  async #claim(messageId: string): Promise<Claim | null> {
    return this.#db.transaction(async (tx) => {
      const mode = await lockIntakeMode(tx)
      const [row] = await tx
        .select({
          state: outbox.state,
          mime: outbox.mime,
          from: outbox.fromAddress,
          ticketId: ticket.id,
          organizationId: ticket.organizationId,
          authorUserId: message.authorUserId,
        })
        .from(outbox)
        .innerJoin(message, eq(message.id, outbox.messageId))
        .innerJoin(ticket, eq(ticket.id, message.ticketId))
        .where(eq(outbox.messageId, messageId))
        .for("update", { of: outbox })
      if (!row) return null
      if (row.state === "sending") {
        // An earlier run claimed this attempt and stopped before it finished: it may have sent. Never again by itself.
        await tx
          .update(outboxRecipient)
          // The stopped attempt may have reached each of them.
          .set({
            state: "unknown",
            possibleSends: sql`${outboxRecipient.possibleSends} + 1`,
            updatedAt: this.#now(),
          })
          .where(and(eq(outboxRecipient.messageId, messageId), ne(outboxRecipient.state, "accepted")))
        await this.#settle(tx, messageId, true)
        log.warn("a reply's earlier attempt stopped halfway; its fate is unknown", { messageId })
        return null
      }
      if (row.state !== "pending") return null
      const problem = await this.#refusal(tx, mode, row)
      if (problem) {
        await tx
          .update(outbox)
          .set({ state: "failed", problem, updatedAt: this.#now() })
          .where(eq(outbox.messageId, messageId))
        await writeAudit(tx, SYSTEM, {
          action: "message.send_refused",
          entityType: "message",
          entityId: messageId,
          details: { problem },
        })
        return null
      }
      const recipients = await tx
        .select({ address: outboxRecipient.address, name: outboxRecipient.name })
        .from(outboxRecipient)
        .where(and(eq(outboxRecipient.messageId, messageId), eq(outboxRecipient.state, "pending")))
        .orderBy(outboxRecipient.position)
      if (recipients.length === 0) {
        await this.#settle(tx, messageId, true)
        return null
      }
      const attempt = randomUUID()
      await tx
        .update(outbox)
        .set({
          state: "sending",
          attempt,
          problem: null,
          attempts: sql`${outbox.attempts} + 1`,
          updatedAt: this.#now(),
        })
        .where(eq(outbox.messageId, messageId))
      return { attempt, mime: row.mime, from: row.from, ticketId: row.ticketId, recipients }
    })
  }

  /** Why the send point refuses this reply now, or null: listening, a From address or an author no longer allowed. */
  async #refusal(
    tx: Tx,
    mode: string,
    row: { from: string; organizationId: string; authorUserId: string | null },
  ): Promise<SendProblem | null> {
    if (mode !== "live") return "listening"
    if (!belongsTo(row.from, await supportRules(tx), row.organizationId)) return "from_not_allowed"
    const [author] = row.authorUserId
      ? await tx
          .select({ id: authUser.id, role: authUser.role, banned: authUser.banned })
          .from(authUser)
          .where(eq(authUser.id, row.authorUserId))
      : []
    if (!author || author.banned) return "author_not_allowed"
    const scope = await visibleOrganizations(tx, { id: author.id, role: author.role ?? "agent" })
    return inScope(scope, row.organizationId) ? null : "author_not_allowed"
  }

  /**
   * Step 3: one provider's answer, per recipient; whom it accepted joins the ticket's participants. Written only while
   * the row is still this attempt's; false (and nothing written) when it is not.
   */
  async #record(messageId: string, claim: Claim, config: SmtpConfig, result: Delivery): Promise<boolean> {
    if (result.kind === "not_sent") {
      log.warn("a provider could not be reached or logged in to; nothing was sent through it", {
        provider: config.provider,
        step: result.step,
        code: result.code,
      })
      return true
    }
    return this.#db.transaction(async (tx) => {
      if (!(await this.#owns(tx, messageId, claim.attempt))) return false
      const now = this.#now()
      const set = async (addresses: string[], state: string, response: string | null) => {
        if (addresses.length === 0) return
        // SMTP2GO's queue ID, from its final 250, finds the recipient for its delivery events (plan 3.3). The delivery
        // columns themselves are only ever written by those events.
        const providerId = state === "accepted" && config.provider === "smtp2go" ? queueIdOf(response) : null
        // An accepted or unknown answer means this attempt may have reached the recipient (possible_sends), and an
        // acceptance is dated by the database's clock, as delivery statuses are (the ticket's flag compares them).
        const reached = state === "accepted" || state === "unknown"
        await tx
          .update(outboxRecipient)
          .set({
            state,
            provider: config.provider,
            response,
            providerId,
            updatedAt: now,
            ...(state === "accepted" ? { acceptedAt: sql`now()` } : {}),
            ...(reached ? { possibleSends: sql`${outboxRecipient.possibleSends} + 1` } : {}),
          })
          .where(and(eq(outboxRecipient.messageId, messageId), inArray(outboxRecipient.address, addresses)))
      }
      if (result.kind === "unknown") {
        const unknown = claim.recipients.map((entry) => entry.address)
        const pending = await tx
          .select({ address: outboxRecipient.address })
          .from(outboxRecipient)
          .where(and(eq(outboxRecipient.messageId, messageId), ne(outboxRecipient.state, "accepted")))
        const left = new Set(pending.map((entry) => entry.address))
        await set(
          unknown.filter((address) => left.has(address)),
          "unknown",
          result.response,
        )
        log.warn("a provider's answer to a reply is unknown; it is not sent again by itself", {
          provider: config.provider,
          code: result.code,
        })
        return true
      }
      await set(result.accepted, "accepted", result.response)
      for (const entry of result.refused) await set([entry.address], "refused", entry.response)
      // A recipient the agent added becomes a participant once a provider accepted the reply for them.
      const accepted = new Set(result.accepted)
      const joined = claim.recipients.filter((entry) => accepted.has(entry.address))
      if (joined.length)
        await tx
          .insert(ticketParticipant)
          .values(joined.map((entry) => ({ ticketId: claim.ticketId, address: entry.address, name: entry.name })))
          .onConflictDoNothing()
      // A reply a recipient accepted may clear the ticket's delivery flag (plan 3.3). In a savepoint: the flag must
      // never keep the provider's answer from being recorded.
      if (joined.length)
        await tx
          .transaction((inner) => refreshDeliveryFlag(inner, claim.ticketId))
          .catch((error) => log.warn("the ticket's delivery flag was not refreshed", errorFacts(error)))
      return true
    })
  }

  /** Step 3's end: the row's state from its recipients, only while the row is still this attempt's. */
  async #finish(messageId: string, attempt: string, configured: boolean): Promise<OutboxState | null> {
    const settled = await this.#db.transaction(async (tx) =>
      (await this.#owns(tx, messageId, attempt)) ? this.#settle(tx, messageId, configured) : null,
    )
    return settled ?? this.#stale(messageId)
  }

  async #settle(tx: Tx, messageId: string, configured: boolean): Promise<OutboxState> {
    const states = (
      await tx
        .select({ state: outboxRecipient.state })
        .from(outboxRecipient)
        .where(eq(outboxRecipient.messageId, messageId))
    ).map((row) => row.state)
    const settled = outboxStateOf(states, configured)
    await tx
      .update(outbox)
      .set({ state: settled.state, problem: settled.problem, attempt: null, updatedAt: this.#now() })
      .where(eq(outbox.messageId, messageId))
    if (settled.state !== "accepted")
      log.info("a reply's sending ended", { messageId, state: settled.state, problem: settled.problem })
    return settled.state
  }

  async #state(messageId: string): Promise<OutboxState | null> {
    const [row] = await this.#db.select({ state: outbox.state }).from(outbox).where(eq(outbox.messageId, messageId))
    return (row?.state as OutboxState | undefined) ?? null
  }
}

/** Runs a send and logs what failed around it: a failed run is tried again by the queue, and the row keeps it safe. */
export async function sendReplyJob(sender: ReplySender, messageId: string): Promise<OutboxState | null> {
  try {
    return await sender.send(messageId)
  } catch (error) {
    log.error("sending a reply failed; the queue tries again", errorFacts(error))
    throw error
  }
}
