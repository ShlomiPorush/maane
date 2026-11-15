// A timed action at its time (plan 4.2), the `timed-action` job: one rule for every timed action
// (apps/server/src/actions/timed.ts). In one transaction, after the intake mode (FOR SHARE), the ticket (FOR UPDATE),
// and the action (FOR UPDATE), in the order every path takes them: the job's version must still be the action's and
// the action still `scheduled` (else a change or a cancellation replaced it, and the job does nothing); the customer
// must not have written since the action was made; and the send point's checks must pass (intake live, the From
// address still the ticket's organization's, the author still allowed on it). A failed check ends the action without
// sending, with its reason. Otherwise the reply is written from the version the server built, with its outbox row
// (at most one per action and version) and its `send-reply` job, and the action becomes `handed`; the send point checks
// it once more in the transaction that takes the row to `sending`. A rerun after a crash finds the action `handed` (or
// the version's outbox row) and makes no second message.
//
// "Send and set pending" applies here, when the reply goes to the send point (in this transaction, by the one status
// writer, as the author), not when it was scheduled; a ticket the author may no longer set to pending (closed meanwhile)
// keeps its status.

import { lockAction, setActionState, ticketOfAction } from "@maane/server/actions/timed"
import { type Actor, SYSTEM, writeAudit } from "@maane/server/audit"
import type { Db } from "@maane/server/db/client"
import { authUser, scheduledReply, ticket, timedAction } from "@maane/server/db/schema"
import { SEND_REPLY, transactionWithJobs } from "@maane/server/jobs/queue"
import { errorFacts, log } from "@maane/server/log"
import { sendProblem } from "@maane/server/replies/checks"
import { ActionWritten, type ReplyFile, writeMessage } from "@maane/server/replies/write"
import { customerWroteSince } from "@maane/server/tickets/customer-reply"
import { changeStatus, lockTicket } from "@maane/server/tickets/status"
import { type ActionReason, type MailAddress, mayChangeStatus } from "@maane/shared"
import { eq } from "drizzle-orm"
import type { Db as QueueDb } from "pg-boss"
import { lockIntakeMode } from "../intake/process.ts"

/** What one run did: wrote the reply (`handed`), found the job stale, or ended the action for this reason. */
export type TimedResult = "handed" | "stale" | ActionReason

export interface TimedActionsOptions {
  db: Db
  /** Queues a job inside the transaction (pg-boss's documented `db` option). */
  queue: (db: QueueDb, name: string, data: object) => Promise<unknown>
  now?: () => Date
}

export class TimedActions {
  readonly #db: Db
  readonly #queue: TimedActionsOptions["queue"]
  readonly #now: () => Date

  constructor(options: TimedActionsOptions) {
    this.#db = options.db
    this.#queue = options.queue
    this.#now = options.now ?? (() => new Date())
  }

  /** Runs the action's version that the job was queued for. */
  async run(actionId: string, version: number): Promise<TimedResult> {
    try {
      return await transactionWithJobs(this.#db, async (tx, jobs) => {
        const mode = await lockIntakeMode(tx)
        const ticketId = await ticketOfAction(tx, actionId)
        const locked = ticketId ? await lockTicket(tx, ticketId) : null
        const action = locked ? await lockAction(tx, actionId) : null
        if (!locked || !action || action.state !== "scheduled" || action.version !== version) return "stale"
        const [content] = await tx
          .select({ reply: scheduledReply, submissionId: timedAction.submissionId })
          .from(scheduledReply)
          .innerJoin(timedAction, eq(timedAction.id, scheduledReply.actionId))
          .where(eq(scheduledReply.actionId, actionId))
        if (!content?.submissionId || !action.authorUserId) return "stale"
        const reply = content.reply
        const problem = (await customerWroteSince(tx, locked.id, actionId))
          ? "customer_reply"
          : await sendProblem(tx, mode, {
              from: reply.fromAddress,
              organizationId: locked.organizationId,
              authorUserId: action.authorUserId,
            })
        if (problem) {
          await setActionState(tx, actionId, "ended", problem)
          log.info("a scheduled reply ended at its time without sending", { actionId, reason: problem })
          return problem
        }
        const at = this.#now()
        const files = reply.files as ReplyFile[]
        const messageId = await writeMessage(
          tx,
          {
            ticketId: locked.id,
            authorUserId: action.authorUserId,
            // The composer's submission: one click, one message, also at its time.
            submissionId: content.submissionId,
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
        if (!messageId) return "stale"
        if (reply.setPending) {
          const [author] = await tx
            .select({ username: authUser.username, name: authUser.name, role: authUser.role })
            .from(authUser)
            .where(eq(authUser.id, action.authorUserId))
          const role = author?.role ?? "agent"
          const actor: Actor = { userId: action.authorUserId, label: author?.username ?? author?.name ?? "?" }
          if (mayChangeStatus(role, locked.status, "pending"))
            await changeStatus(tx, locked, "pending", { role, actor, ipAddress: null }, "reply")
        }
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
    } catch (error) {
      // This version made its reply already (a rerun raced it): nothing is written twice.
      if (error instanceof ActionWritten) return "stale"
      throw error
    }
  }
}

/** Runs a timed action and logs what failed around it: the queue tries again, and the version keeps it safe. */
export async function timedActionJob(actions: TimedActions, actionId: string, version: number): Promise<TimedResult> {
  try {
    return await actions.run(actionId, version)
  } catch (error) {
    log.error("a timed action failed; the queue tries again", errorFacts(error))
    throw error
  }
}
