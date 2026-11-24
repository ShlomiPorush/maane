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
import { type Delivery, deliver, SMTP_TIMEOUTS, type SmtpConfig, type SmtpTimeouts, smtpConfig } from "./smtp.ts"

export interface ReplySenderOptions {
  db: Db
  settings: Settings
  queue: (jobs: QueueDb, name: string, data: object, startAfter: Date) => Promise<unknown>
  timeouts?: SmtpTimeouts
  afterClaim?: (messageId: string) => Promise<void>
  afterSend?: (messageId: string) => Promise<void>
  afterRecord?: (messageId: string) => Promise<void>
  now?: () => Date
}

type Claim = {
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
      const from = config.provider === "failover" && bounce ? bounce : claim.from
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

  async #owns(tx: Tx, messageId: string, attempt: string): Promise<boolean> {
    const [row] = await tx
      .select({ state: outbox.state, attempt: outbox.attempt })
      .from(outbox)
      .where(eq(outbox.messageId, messageId))
      .for("update")
    return row?.state === "sending" && row.attempt === attempt
  }

  async #stale(messageId: string): Promise<OutboxState | null> {
    log.warn("a reply's attempt is no longer current; it stops without sending or writing", { messageId })
    return this.#state(messageId)
  }

  async #claim(messageId: string): Promise<Claim | null> {
    return transactionWithJobs(this.#db, async (tx, jobs) => {
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
        await tx
          .update(outboxRecipient)
          .set({ state: "unknown", updatedAt: this.#now() })
          .where(and(eq(outboxRecipient.messageId, messageId), ne(outboxRecipient.state, "accepted")))
        await this.#settle(tx, messageId, true)
        log.warn("a reply's earlier attempt stopped halfway; its fate is unknown", { messageId })
        return null
      }
      if (row.state !== "pending") return null
      const [held] = await tx
        .select({ organizationId: ticket.organizationId, status: ticket.status })
        .from(ticket)
        .where(eq(ticket.id, row.ticketId))
        .for("key share")
      if (!held) return null
      const action = row.actionId ? await lockAction(tx, row.actionId) : null
      const handoff = action?.state === "handed" && action.version === row.actionVersion
      const automated = action?.kind === "reminder"
      let problem: SendProblem | null = null
      let ended: ActionReason | null = null
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
      problem ??= await sendProblem(tx, { ...row, organizationId: held.organizationId, automated })
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
      if (handoff && action) await setActionState(tx, action.id, "done")
      const attempt = randomUUID()
      await tx
        .update(outbox)
        .set({
          state: "sending",
          attempt,
          problem: null,
          updatedAt: this.#now(),
        })
        .where(eq(outbox.messageId, messageId))
      await tx
        .update(outboxRecipient)
        .set({ possibleSends: sql`${outboxRecipient.possibleSends} + 1` })
        .where(and(eq(outboxRecipient.messageId, messageId), eq(outboxRecipient.state, "pending")))
      if (handoff && action?.kind === "reply" && action.authorUserId)
        await this.#replyGoes(tx, jobs, { ticketId: row.ticketId, messageId, actionId: action.id }, action.authorUserId)
      return { attempt, mime: row.mime, from: row.from, ticketId: row.ticketId, recipients }
    })
  }

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
        const providerId = state === "accepted" && config.provider === "smtp2go" ? queueIdOf(response) : null
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
      const accepted = new Set(result.accepted)
      const joined = claim.recipients.filter((entry) => accepted.has(entry.address))
      if (joined.length)
        await tx
          .insert(ticketParticipant)
          .values(joined.map((entry) => ({ ticketId: claim.ticketId, address: entry.address, name: entry.name })))
          .onConflictDoNothing()
      // Without this savepoint, a failed refresh would silently roll back the provider's answer recorded above.
      if (joined.length)
        await tx
          .transaction((inner) => refreshDeliveryFlag(inner, claim.ticketId))
          .catch((error) => log.warn("the ticket's delivery flag was not refreshed", errorFacts(error)))
      return true
    })
  }

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

export async function sendReplyJob(sender: ReplySender, messageId: string): Promise<OutboxState | null> {
  try {
    return await sender.send(messageId)
  } catch (error) {
    log.error("sending a reply failed; the queue tries again", errorFacts(error))
    throw error
  }
}
