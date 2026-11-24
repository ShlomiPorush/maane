import { and, eq, isNotNull, sql } from "drizzle-orm"
import { SYSTEM, writeAudit } from "../audit.ts"
import type { Db } from "../db/client.ts"
import { ticket } from "../db/schema.ts"
import { refuseImported } from "../imports/window.ts"
import { type JobQueue, SNOOZE_END, transactionWithJobs } from "../jobs/queue.ts"
import { Refusal } from "../organizations/refusal.ts"
import { inScope, type OrganizationScope } from "../organizations/scope.ts"
import { changeStatus, type LockedTicket, lockTicket, type StatusActor } from "./status.ts"
import type { WorkflowUser } from "./workflow.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

async function snoozeOf(tx: Pick<Tx, "select">, ticketId: string) {
  const [row] = await tx
    .select({ until: ticket.snoozedUntil, due: sql<boolean>`coalesce(${ticket.snoozedUntil} <= now(), false)` })
    .from(ticket)
    .where(eq(ticket.id, ticketId))
  return row ?? null
}

async function endSnooze(tx: Tx, locked: LockedTicket, by: StatusActor, via: "agent" | "time"): Promise<void> {
  await tx.update(ticket).set({ snoozedUntil: null }).where(eq(ticket.id, locked.id))
  if (locked.status === "pending") await changeStatus(tx, locked, "open", by, "snooze")
  await writeAudit(tx, by.actor, {
    action: "ticket.unsnooze",
    entityType: "ticket",
    entityId: locked.id,
    details: { ticket: locked.number, via },
    ipAddress: "ipAddress" in by ? by.ipAddress : null,
  })
}

export async function customerEndsSnooze(
  tx: Pick<Tx, "update" | "insert">,
  locked: Pick<LockedTicket, "id" | "number">,
): Promise<boolean> {
  const ended = await tx
    .update(ticket)
    .set({ snoozedUntil: null })
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

export async function snoozeEnded(db: Db, ticketId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const locked = await lockTicket(tx, ticketId)
    if (!locked) return false
    const current = await snoozeOf(tx, ticketId)
    if (!current?.due) return false
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
    await refuseImported(tx, locked.id)
    return locked
  }

  async snooze(scope: OrganizationScope, user: WorkflowUser, number: number, until: Date): Promise<void> {
    if (until.getTime() <= Date.now()) throw new Refusal("time_past", 400)
    await transactionWithJobs(this.db, async (tx, jobs) => {
      const locked = await this.#locked(tx, scope, number)
      await tx.update(ticket).set({ snoozedUntil: until }).where(eq(ticket.id, locked.id))
      await this.jobs.sendIn(jobs, SNOOZE_END, { ticketId: locked.id }, { startAfter: until })
      await writeAudit(tx, user.actor, {
        action: "ticket.snooze",
        entityType: "ticket",
        entityId: locked.id,
        details: { ticket: locked.number, until: until.toISOString() },
        ipAddress: user.ipAddress,
      })
    })
  }

  async wake(scope: OrganizationScope, user: WorkflowUser, number: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const locked = await this.#locked(tx, scope, number)
      const current = await snoozeOf(tx, locked.id)
      if (!current?.until) return
      await endSnooze(tx, locked, user, "agent")
    })
  }
}
