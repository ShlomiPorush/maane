// Sending a reply (plan 3.1), the `send-reply` job. The outbox row, not the queue, decides whether anything may go:
//
// 1. One transaction locks the intake mode (FOR SHARE) and the outbox row (FOR UPDATE). A row that is `sending` was
//    left by a run that stopped halfway (a crash, or pg-boss expired the job while its handler still ran): it may have
//    been sent, so every recipient not accepted becomes `unknown` and nothing is sent. Only a `pending` row goes on.
//    The send point checks again what the server checked when the agent wrote the reply: intake is live, the From
//    address still belongs to the ticket's organization, and the author may still answer the ticket. Then the row
//    becomes `sending` and the transaction commits, before the first byte leaves.
//    A row a timed action made (plan 4.2) is checked once more here, in this transaction, the first time it is
//    claimed: its action must still be `handed` at the row's version (not cancelled or replaced), and the customer
//    must not have written since the action was made. A failed check ends the action without sending. When it passes,
//    its status action ("Send and set pending") applies in this transaction, and only then. A later claim (Send again)
//    goes on only for the row of the version that passed (`done` at the row's version).
//    A reminder's row (plan 4.3) is checked the same way, with its own checks: its waiting period still Maane's own and
//    open, the ticket still pending, the customer silent, the reply that started the period not bounced; it has no
//    author (Maane sends it as the organization), and it never goes again (Send again refuses it). A scheduled reply
//    that goes ends the ticket's waiting period, and one that sets the ticket to pending starts a new one with its
//    reminder, in this transaction, after its status action.
//    The claim gives the attempt an ID of its own (outbox.attempt). Every later step goes on only while the row is
//    still `sending` under that ID, checked under the row's lock: right before each send, and with each result. An
//    attempt another run made stale (marked unknown, sent again) stops there, without sending or writing.
// 2. SMTP2GO, then the failover server, each through one attempt (smtp.ts). The failover gets only what SMTP2GO did
//    not take for certain: everything when SMTP2GO could not be reached or logged in to, the refused recipients when it
//    refused some. An unknown outcome ends the attempt there: nothing goes to the failover.
// 3. Each provider's answer is stored per recipient; a recipient it accepted becomes a participant of the ticket. The
//    row's state then follows its recipients (OUTBOX_STATES).

import { randomUUID } from "node:crypto"
import { actionPassed, lockAction, setActionState } from "@maane/server/actions/timed"
import { SYSTEM, writeAudit } from "@maane/server/audit"
import type { Db } from "@maane/server/db/client"
import {
  authUser,
  message,
  outbox,
  outboxRecipient,
  scheduledReply,
  ticket,
  ticketParticipant,
} from "@maane/server/db/schema"
import { queueIdOf, refreshDeliveryFlag } from "@maane/server/delivery/service"
import { TIMED_ACTION, transactionWithJobs } from "@maane/server/jobs/queue"
import { errorFacts, log } from "@maane/server/log"
import { reminderProblem } from "@maane/server/reminders/checks"
import { endWaitingPeriod, startWaitingPeriod } from "@maane/server/reminders/periods"
import { sendProblem } from "@maane/server/replies/checks"
import type { Settings } from "@maane/server/settings/service"
import { customerWroteSince } from "@maane/server/tickets/customer-reply"
import { changeStatus, type LockedTicket } from "@maane/server/tickets/status"
import {
  type ActionReason,
  mayChangeStatus,
  type OutboxState,
  outboxStateOf,
  PROVIDERS,
  type SendProblem,
  type TicketStatus,
} from "@maane/shared"
import { and, eq, inArray, ne, sql } from "drizzle-orm"
import type { Db as QueueDb } from "pg-boss"
import type { Tx } from "../files/types.ts"
import { lockIntakeMode } from "../intake/process.ts"
import { type Delivery, deliver, SMTP_TIMEOUTS, type SmtpConfig, type SmtpTimeouts, smtpConfig } from "./smtp.ts"

export interface ReplySenderOptions {
  db: Db
  settings: Settings
  /**
   * Queues a job inside the claim's transaction (pg-boss's documented `db` option): a scheduled reply that sets the
   * ticket to pending starts a waiting period there, whose reminder's `timed-action` job waits for its time (plan 4.3).
   */
  queue: (jobs: QueueDb, name: string, data: object, startAfter: Date) => Promise<unknown>
  timeouts?: SmtpTimeouts
  /** Called right after the attempt was committed as `sending`, before anything is sent: a test stops a run here. */
  afterClaim?: (messageId: string) => Promise<void>
  /**
   * Test hooks around one provider's answer: right after it answered, before it is saved, and right after it is saved.
   * A test that throws there stops the run as a crash would.
   */
  afterSend?: (messageId: string) => Promise<void>
  afterRecord?: (messageId: string) => Promise<void>
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
  readonly #queue: ReplySenderOptions["queue"]
  readonly #timeouts: SmtpTimeouts
  readonly #afterClaim?: (messageId: string) => Promise<void>
  readonly #afterSend?: (messageId: string) => Promise<void>
  readonly #afterRecord?: (messageId: string) => Promise<void>
  readonly #now: () => Date

  constructor(options: ReplySenderOptions) {
    this.#db = options.db
    this.#settings = options.settings
    this.#queue = options.queue
    this.#timeouts = options.timeouts ?? SMTP_TIMEOUTS
    this.#afterClaim = options.afterClaim
    this.#afterSend = options.afterSend
    this.#afterRecord = options.afterRecord
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
      await this.#afterSend?.(messageId)
      if (!(await this.#record(messageId, claim, config, result))) return this.#stale(messageId)
      await this.#afterRecord?.(messageId)
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
    return transactionWithJobs(this.#db, async (tx, jobs) => {
      const mode = await lockIntakeMode(tx)
      const [row] = await tx
        .select({
          state: outbox.state,
          mime: outbox.mime,
          from: outbox.fromAddress,
          ticketId: ticket.id,
          authorUserId: message.authorUserId,
          actionId: outbox.actionId,
          actionVersion: outbox.actionVersion,
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
          // Not a new attempt: its claim already counted it in possible_sends.
          .set({ state: "unknown", updatedAt: this.#now() })
          .where(and(eq(outboxRecipient.messageId, messageId), ne(outboxRecipient.state, "accepted")))
        await this.#settle(tx, messageId, true)
        log.warn("a reply's earlier attempt stopped halfway; its fate is unknown", { messageId })
        return null
      }
      if (row.state !== "pending") return null
      // The ticket's organization, read under a lock a move waits for (FOR KEY SHARE against its FOR UPDATE; the move
      // is the only writer of the organization), taken after the outbox row as every path that holds both takes them:
      // a move and this claim serialize, so the checks below and the switch to `sending` see the organization the
      // ticket has while the reply goes. KEY SHARE, not SHARE (review S7): the webhook locks a recipient row and then
      // the ticket FOR NO KEY UPDATE to refresh its delivery flag, which KEY SHARE does not block, so a claim waiting
      // for that recipient row below never holds up the webhook it waits for.
      const [held] = await tx
        .select({ organizationId: ticket.organizationId, status: ticket.status })
        .from(ticket)
        .where(eq(ticket.id, row.ticketId))
        .for("key share")
      if (!held) return null
      // A timed action's row (plan 4.2): its action, locked after the ticket as every path takes them. Its first claim
      // (the action `handed`) checks it once more; a later one (Send again after it passed) is an ordinary reply's,
      // except a reminder's.
      const action = row.actionId ? await lockAction(tx, row.actionId) : null
      const handoff = action?.state === "handed" && action.version === row.actionVersion
      // An automatic reminder (plan 4.3): no author, and its waiting period's checks at every claim, Send again's too
      // (its action stays `done` then; only the row fails).
      const automated = action?.kind === "reminder"
      let problem: SendProblem | null = null
      let ended: ActionReason | null = null
      // Only the row of the version that passed goes again: an earlier version's row (changed after it was written)
      // never does.
      if (row.actionId && !handoff && !actionPassed(action, row.actionVersion))
        problem = automated ? "reminder_ended" : action?.reason === "customer_reply" ? "customer_reply" : "action_ended"
      else if (row.actionId && automated) {
        ended = await reminderProblem(tx, row.actionId, {
          id: row.ticketId,
          status: held.status as TicketStatus,
        })
        if (ended) problem = "reminder_ended"
      } else if (handoff && row.actionId && (await customerWroteSince(tx, row.ticketId, row.actionId)))
        problem = "customer_reply"
      problem ??= await sendProblem(tx, mode, { ...row, organizationId: held.organizationId, automated })
      if (problem) {
        if (handoff && action && (ended || problem !== "action_ended"))
          await setActionState(tx, action.id, "ended", ended ?? (problem as ActionReason))
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
      // The action passed: it is at the send point now, and its reply goes on as any other.
      if (handoff && action) await setActionState(tx, action.id, "done")
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
      // Every recipient of this attempt may be reached from its first byte on (possible_sends), counted here, in the
      // claim, so a run that stops after a provider took the data and before its answer is saved is counted too.
      await tx
        .update(outboxRecipient)
        .set({ possibleSends: sql`${outboxRecipient.possibleSends} + 1` })
        .where(and(eq(outboxRecipient.messageId, messageId), eq(outboxRecipient.state, "pending")))
      // A scheduled reply's status action ("Send and set pending"), now that it goes, and only then, with its waiting
      // period (plan 4.3): the last writes of the claim, so the ticket's stronger lock comes after the recipients'
      // rows, as the webhook's order needs. A reminder changes neither the status nor the period.
      if (handoff && action?.kind === "reply" && action.authorUserId)
        await this.#replyGoes(tx, jobs, { ticketId: row.ticketId, messageId, actionId: action.id }, action.authorUserId)
      return { attempt, mime: row.mime, from: row.from, ticketId: row.ticketId, recipients }
    })
  }

  /**
   * A scheduled reply goes to sending: it ends the ticket's waiting period (a new agent reply, plan 4.3) and, when it
   * asked for it, sets the ticket to pending by the one status writer, as its author, and starts a new waiting period
   * with its reminder. The ticket is locked FOR NO KEY UPDATE (it does not conflict with the KEY SHARE this claim and
   * others hold, so two claims of one ticket wait for each other instead of deadlocking) and its status read again
   * under that lock. A ticket the author may no longer set to pending (closed meanwhile, not an admin) keeps its status.
   */
  async #replyGoes(
    tx: Db,
    jobs: QueueDb,
    reply: { ticketId: string; messageId: string; actionId: string },
    authorUserId: string,
  ): Promise<void> {
    const { ticketId, messageId, actionId } = reply
    const [content] = await tx
      .select({ setPending: scheduledReply.setPending })
      .from(scheduledReply)
      .where(eq(scheduledReply.actionId, actionId))
    const [held] = await tx
      .select({ id: ticket.id, number: ticket.number, status: ticket.status, organizationId: ticket.organizationId })
      .from(ticket)
      .where(eq(ticket.id, ticketId))
      .for("no key update")
    const [author] = await tx
      .select({ username: authUser.username, name: authUser.name, role: authUser.role })
      .from(authUser)
      .where(eq(authUser.id, authorUserId))
    if (!held) return
    await endWaitingPeriod(tx, ticketId, "agent_reply")
    if (!content?.setPending) return
    const locked: LockedTicket = { ...held, status: held.status as TicketStatus }
    const role = author?.role ?? "agent"
    if (!mayChangeStatus(role, locked.status, "pending")) return
    const actor = { userId: authorUserId, label: author?.username ?? author?.name ?? "?" }
    await changeStatus(tx, locked, "pending", { role, actor, ipAddress: null }, "reply")
    if (locked.status === "pending")
      await startWaitingPeriod(tx, ticketId, messageId, (data, startAfter) =>
        this.#queue(jobs, TIMED_ACTION, data, startAfter),
      )
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
        // An acceptance is dated by the database's clock, as delivery statuses are (the ticket's flag compares them).
        await tx
          .update(outboxRecipient)
          .set({
            state,
            provider: config.provider,
            response,
            providerId,
            updatedAt: now,
            ...(state === "accepted" ? { acceptedAt: sql`now()` } : {}),
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

  async #settle(tx: Pick<Tx, "select" | "update">, messageId: string, configured: boolean): Promise<OutboxState> {
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
