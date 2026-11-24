import { randomUUID } from "node:crypto"
import { lockAction, setActionState, ticketOfAction } from "@maane/server/actions/timed"
import { SYSTEM, writeAudit } from "@maane/server/audit"
import type { Db } from "@maane/server/db/client"
import { scheduledReply, ticket, timedAction } from "@maane/server/db/schema"
import { SEND_REPLY, SNOOZE_END, TIMED_ACTION, transactionWithJobs } from "@maane/server/jobs/queue"
import { errorFacts, log } from "@maane/server/log"
import { reminderProblem } from "@maane/server/reminders/checks"
import { reminderMessage } from "@maane/server/reminders/mail"
import { sendProblem } from "@maane/server/replies/checks"
import { type ReplyFile, writeMessage } from "@maane/server/replies/write"
import type { Settings } from "@maane/server/settings/service"
import { customerWroteSince } from "@maane/server/tickets/customer-reply"
import { type LockedTicket, lockTicket } from "@maane/server/tickets/status"
import type { ActionReason, Locale, MailAddress } from "@maane/shared"
import { and, eq, sql } from "drizzle-orm"
import type { Db as QueueDb } from "pg-boss"

export type TimedResult = "handed" | "stale" | ActionReason

export interface TimedActionsOptions {
  db: Db
  settings: Settings
  queue: (db: QueueDb, name: string, data: object) => Promise<unknown>
}

export class TimedActions {
  readonly #db: Db
  readonly #settings: Settings
  readonly #queue: TimedActionsOptions["queue"]

  constructor(options: TimedActionsOptions) {
    this.#db = options.db
    this.#settings = options.settings
    this.#queue = options.queue
  }

  async run(actionId: string, version: number): Promise<TimedResult> {
    const locale = (await this.#settings.get("general.defaultLocale")) as Locale
    return transactionWithJobs(this.#db, async (tx, jobs) => {
      const ticketId = await ticketOfAction(tx, actionId)
      const locked = ticketId ? await lockTicket(tx, ticketId) : null
      const action = locked ? await lockAction(tx, actionId) : null
      if (!locked || !action || action.state !== "scheduled" || action.version !== version) return "stale"
      if (action.kind === "reminder") return this.#reminder(tx, jobs, locked, actionId, version, locale)
      const [reply] = await tx.select().from(scheduledReply).where(eq(scheduledReply.actionId, actionId))
      if (!reply || !action.authorUserId) return "stale"
      const problem = (await customerWroteSince(tx, locked.id, actionId))
        ? "customer_reply"
        : await sendProblem(tx, {
            from: reply.fromAddress,
            organizationId: locked.organizationId,
            authorUserId: action.authorUserId,
          })
      if (problem) {
        await setActionState(tx, actionId, "ended", problem)
        log.info("a scheduled reply ended at its time without sending", { actionId, reason: problem })
        return problem
      }
      const at = new Date()
      const files = reply.files as ReplyFile[]
      const messageId = await writeMessage(
        tx,
        {
          ticketId: locked.id,
          authorUserId: action.authorUserId,
          submissionId: randomUUID(),
          at,
          ready: {
            kind: "reply",
            from: reply.fromAddress,
            to: reply.toAddresses as MailAddress[],
            cc: reply.ccAddresses as MailAddress[],
            html: reply.htmlBody,
            text: reply.textBody,
            files,
            built: {
              mime: reply.mime,
              messageId: reply.messageIdHeader,
              subject: reply.subject,
              inReplyTo: reply.inReplyTo,
              references: reply.references,
            },
            links: reply.links as Parameters<typeof writeMessage>[1]["ready"]["links"],
          },
          action: { id: actionId, version },
        },
        (data) => this.#queue(jobs, SEND_REPLY, data),
      )
      await tx.update(ticket).set({ lastActivityAt: at }).where(eq(ticket.id, locked.id))
      await setActionState(tx, actionId, "handed")
      await writeAudit(tx, SYSTEM, {
        action: "message.reply",
        entityType: "message",
        entityId: messageId,
        details: {
          ticket: locked.number,
          from: reply.fromAddress,
          recipients: [...(reply.toAddresses as MailAddress[]), ...(reply.ccAddresses as MailAddress[])].map(
            (entry) => entry.address,
          ),
          files: files.length,
          scheduled: actionId,
        },
      })
      return "handed"
    })
  }

  async #reminder(
    tx: Db,
    jobs: QueueDb,
    locked: LockedTicket,
    actionId: string,
    version: number,
    locale: Locale,
  ): Promise<TimedResult> {
    const end = async (reason: ActionReason) => {
      await setActionState(tx, actionId, "ended", reason)
      log.info("a reminder ended at its time without sending", { actionId, reason })
      return reason
    }
    const problem = await reminderProblem(tx, actionId, locked)
    if (problem) return end(problem)
    const at = new Date()
    const ready = await reminderMessage(tx, locked.id, locale, at)
    if (typeof ready === "string") return end(ready)
    const refused = await sendProblem(tx, {
      from: ready.from ?? "",
      organizationId: locked.organizationId,
      authorUserId: null,
      automated: true,
    })
    if (refused) return end(refused)
    const messageId = await writeMessage(
      tx,
      {
        ticketId: locked.id,
        authorUserId: null,
        submissionId: randomUUID(),
        at,
        ready,
        action: { id: actionId, version },
      },
      (data) => this.#queue(jobs, SEND_REPLY, data),
    )
    await setActionState(tx, actionId, "handed")
    await writeAudit(tx, SYSTEM, {
      action: "message.reminder",
      entityType: "message",
      entityId: messageId,
      details: {
        ticket: locked.number,
        from: ready.from,
        recipients: [...ready.to, ...ready.cc].map((entry) => entry.address),
        reminder: actionId,
      },
    })
    return "handed"
  }
}

export const OVERDUE = "5 minutes"

export async function requeueOverdue(
  db: Db,
  send: (name: string, data: object) => Promise<unknown>,
): Promise<{ actions: number; snoozes: number }> {
  const actions = await db
    .select({ actionId: timedAction.id, version: timedAction.version })
    .from(timedAction)
    .where(and(eq(timedAction.state, "scheduled"), sql`${timedAction.dueAt} < now() - ${OVERDUE}::interval`))
  const snoozes = await db
    .select({ ticketId: ticket.id })
    .from(ticket)
    .where(sql`${ticket.snoozedUntil} < now() - ${OVERDUE}::interval`)
  for (const data of actions) await send(TIMED_ACTION, data)
  for (const data of snoozes) await send(SNOOZE_END, data)
  if (actions.length + snoozes.length > 0)
    log.warn("timed jobs past their time were queued again", { actions: actions.length, snoozes: snoozes.length })
  return { actions: actions.length, snoozes: snoozes.length }
}

export async function timedActionJob(actions: TimedActions, actionId: string, version: number): Promise<TimedResult> {
  try {
    return await actions.run(actionId, version)
  } catch (error) {
    log.error("a timed action failed; the queue tries again", errorFacts(error))
    throw error
  }
}
