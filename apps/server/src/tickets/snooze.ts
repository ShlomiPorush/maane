// Snooze (plan 4.2): the agent picks a time and the ticket leaves the default list until then (the list compares the
// time itself, so a late job never keeps a ticket hidden). Each snooze, and each end of one, moves the ticket's
// `snooze_version` on; the `snooze-end` job names the version it was queued for, so a replaced snooze's job does
// nothing. When a snooze ends, by its time or by the agent's hand, the ticket returns by its status: a pending ticket is
// set to open (through the one status writer, audited), and a ticket solved or closed meanwhile stays as it is. A
// customer reply ends a snooze at once, in the transaction that attaches it (customer-reply.ts). Every change runs on
// the ticket row locked FOR UPDATE. Kept free of sharp: the worker loads it.

import { and, eq, isNotNull, sql } from "drizzle-orm"
import { SYSTEM, writeAudit } from "../audit.ts"
import type { Db } from "../db/client.ts"
import { ticket } from "../db/schema.ts"
import { type JobQueue, SNOOZE_END, transactionWithJobs } from "../jobs/queue.ts"
import { Refusal } from "../organizations/refusal.ts"
import { inScope, type OrganizationScope } from "../organizations/scope.ts"
import { changeStatus, type LockedTicket, lockTicket, type StatusActor } from "./status.ts"
import type { WorkflowUser } from "./workflow.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** The ticket's snooze, read from the row the caller locked. */
async function snoozeOf(tx: Pick<Tx, "select">, ticketId: string) {
  const [row] = await tx
    .select({ until: ticket.snoozedUntil, version: ticket.snoozeVersion })
    .from(ticket)
    .where(eq(ticket.id, ticketId))
  return row ?? null
}

/**
 * Ends the snooze of a locked ticket: no snooze any more, a new version (so its job does nothing), and a pending ticket
 * set to open by the one status writer. Audited as `ticket.unsnooze` with how it ended.
 */
async function endSnooze(tx: Tx, locked: LockedTicket, by: StatusActor, via: "agent" | "time"): Promise<void> {
  await tx
    .update(ticket)
    .set({ snoozedUntil: null, snoozeVersion: sql`${ticket.snoozeVersion} + 1` })
    .where(eq(ticket.id, locked.id))
  if (locked.status === "pending") await changeStatus(tx, locked, "open", by, "snooze")
  await writeAudit(tx, by.actor, {
    action: "ticket.unsnooze",
    entityType: "ticket",
    entityId: locked.id,
    details: { ticket: locked.number, via },
    ipAddress: "ipAddress" in by ? by.ipAddress : null,
  })
}

/**
 * A customer reply ends the ticket's snooze at once (the reply itself already opened the ticket), in the transaction
 * that attaches it, on the ticket the caller locked. Returns whether there was one.
 */
export async function customerEndsSnooze(
  tx: Pick<Tx, "update" | "insert">,
  locked: Pick<LockedTicket, "id" | "number">,
): Promise<boolean> {
  const ended = await tx
    .update(ticket)
    .set({ snoozedUntil: null, snoozeVersion: sql`${ticket.snoozeVersion} + 1` })
    .where(and(eq(ticket.id, locked.id), isNotNull(ticket.snoozedUntil)))
    .returning({ id: ticket.id })
  if (ended.length === 0) return false
  await writeAudit(tx, SYSTEM, {
    action: "ticket.unsnooze",
    entityType: "ticket",
    entityId: locked.id,
    details: { ticket: locked.number, via: "customer_reply" },
  })
  return true
}

/**
 * The `snooze-end` job: ends the snooze it was queued for, unless a newer snooze replaced it or it ended already.
 * Returns whether it ended one.
 */
export async function snoozeEnded(db: Db, ticketId: string, version: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const locked = await lockTicket(tx, ticketId)
    if (!locked) return false
    const current = await snoozeOf(tx, ticketId)
    if (!current?.until || current.version !== version) return false
    await endSnooze(tx, locked, { role: "system", actor: SYSTEM }, "time")
    return true
  })
}

export class Snoozes {
  constructor(
    private readonly db: Db,
    private readonly jobs: JobQueue,
  ) {}

  async #locked(tx: Pick<Db, "select">, scope: OrganizationScope, number: number): Promise<LockedTicket> {
    const [row] = await tx.select({ id: ticket.id }).from(ticket).where(eq(ticket.number, number))
    const locked = row ? await lockTicket(tx, row.id) : null
    if (!locked || !inScope(scope, locked.organizationId)) throw new Refusal("not_found", 404)
    return locked
  }

  /** Snoozes the ticket until this instant (in the future), replacing any snooze it has. */
  async snooze(scope: OrganizationScope, user: WorkflowUser, number: number, until: Date): Promise<void> {
    if (until.getTime() <= Date.now()) throw new Refusal("time_past", 400)
    await transactionWithJobs(this.db, async (tx, jobs) => {
      const locked = await this.#locked(tx, scope, number)
      const [row] = await tx
        .update(ticket)
        .set({ snoozedUntil: until, snoozeVersion: sql`${ticket.snoozeVersion} + 1` })
        .where(eq(ticket.id, locked.id))
        .returning({ version: ticket.snoozeVersion })
      if (!row) throw new Refusal("not_found", 404)
      await this.jobs.sendIn(jobs, SNOOZE_END, { ticketId: locked.id, version: row.version }, { startAfter: until })
      await writeAudit(tx, user.actor, {
        action: "ticket.snooze",
        entityType: "ticket",
        entityId: locked.id,
        details: { ticket: locked.number, until: until.toISOString() },
        ipAddress: user.ipAddress,
      })
    })
  }

  /** Ends the ticket's snooze by hand, as its time would: a pending ticket becomes open. Nothing when not snoozed. */
  async wake(scope: OrganizationScope, user: WorkflowUser, number: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const locked = await this.#locked(tx, scope, number)
      const current = await snoozeOf(tx, locked.id)
      if (!current?.until) return
      await endSnooze(tx, locked, user, "agent")
    })
  }
}
