// What an agent changes on a ticket from its view (plan 4.1): the status, the categories, and the organization. Each
// change runs in one transaction on the ticket row locked FOR UPDATE, within the user's scope (read on each request; a
// ticket outside it is not found), and writes its audit row only when something changed.
//
// A move takes the ticket to another organization: an admin may move any ticket; an agent only between two
// organizations they belong to. From then on its replies come from the new organization's addresses: the composer
// offers them, and the From check of a reply (when written and when sent) reads the ticket's organization. A move
// cancels the ticket's scheduled replies that have not gone to the send point, in its own transaction (plan 4.2), and
// rebuilds the reminder of its waiting period from the new organization's template and days (plan 4.3, periods.ts).

import type { CategoryRef, OrganizationRef, TicketStatus } from "@maane/shared"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { cancelTicketActions } from "../actions/timed.ts"
import { type Actor, writeAudit } from "../audit.ts"
import type { Db } from "../db/client.ts"
import { category, organization, ticket, ticketCategory } from "../db/schema.ts"
import { refuseImported } from "../imports/window.ts"
import { type JobQueue, TIMED_ACTION, transactionWithJobs } from "../jobs/queue.ts"
import { Refusal } from "../organizations/refusal.ts"
import { inScope, type OrganizationScope } from "../organizations/scope.ts"
import { endWaitingPeriodForMove, openWaitingPeriod } from "../reminders/periods.ts"
import { fromAddresses, supportRules } from "../replies/rules.ts"
import { changeStatus, type LockedTicket, lockTicket } from "./status.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** The user a change acts for. */
export type WorkflowUser = { id: string; role: string; actor: Actor; ipAddress: string | null }

/** The organizations the user may move a ticket of this organization to: every other one in their scope. */
export async function moveTargets(
  db: Db,
  scope: OrganizationScope,
  organizationId: string,
): Promise<OrganizationRef[]> {
  if (!inScope(scope, organizationId)) return []
  const rows = await db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(
      scope.all
        ? undefined
        : inArray(organization.id, scope.organizationIds.length ? scope.organizationIds : [organizationId]),
    )
    .orderBy(asc(sql`lower(${organization.name})`))
  return rows.filter((row) => row.id !== organizationId)
}

export class Workflow {
  constructor(
    private readonly db: Db,
    private readonly jobs: JobQueue,
  ) {}

  /** The ticket by number, locked, inside the scope; a 404 refusal otherwise (outside the scope it does not exist). */
  async #locked(tx: Pick<Tx, "select">, scope: OrganizationScope, number: number): Promise<LockedTicket> {
    const [row] = await tx.select({ id: ticket.id }).from(ticket).where(eq(ticket.number, number))
    const locked = row ? await lockTicket(tx, row.id) : null
    if (!locked || !inScope(scope, locked.organizationId)) throw new Refusal("not_found", 404)
    // An imported ticket is read-only until the import is finished (plan 5.1).
    await refuseImported(tx, locked.id)
    return locked
  }

  /** The status control: any status, but `closed` is set and left only by an admin. */
  async setStatus(scope: OrganizationScope, user: WorkflowUser, number: number, to: TicketStatus): Promise<void> {
    await this.db.transaction(async (tx) => {
      const locked = await this.#locked(tx, scope, number)
      await changeStatus(tx, locked, to, user, "agent")
    })
  }

  /** Replaces the ticket's categories with these; every one must exist. */
  async setCategories(scope: OrganizationScope, user: WorkflowUser, number: number, ids: string[]): Promise<void> {
    const wanted = [...new Set(ids)]
    await this.db.transaction(async (tx) => {
      const locked = await this.#locked(tx, scope, number)
      const found = wanted.length
        ? await tx
            .select({ id: category.id, name: category.name })
            .from(category)
            .where(inArray(category.id, wanted))
            .for("share")
        : []
      if (found.length !== wanted.length) throw new Refusal("category_not_found", 404)
      const current = await tx
        .select({ id: ticketCategory.categoryId, name: category.name })
        .from(ticketCategory)
        .innerJoin(category, eq(category.id, ticketCategory.categoryId))
        .where(eq(ticketCategory.ticketId, locked.id))
      const has = new Set(current.map((row) => row.id))
      const added = found.filter((row) => !has.has(row.id))
      const removed = current.filter((row) => !wanted.includes(row.id))
      if (added.length === 0 && removed.length === 0) return
      if (removed.length)
        await tx.delete(ticketCategory).where(
          and(
            eq(ticketCategory.ticketId, locked.id),
            inArray(
              ticketCategory.categoryId,
              removed.map((row) => row.id),
            ),
          ),
        )
      if (added.length)
        await tx.insert(ticketCategory).values(added.map((row) => ({ ticketId: locked.id, categoryId: row.id })))
      await writeAudit(tx, user.actor, {
        action: "ticket.categories",
        entityType: "ticket",
        entityId: locked.id,
        details: {
          ticket: locked.number,
          added: added.map((row) => row.name).sort(),
          removed: removed.map((row) => row.name).sort(),
        },
        ipAddress: user.ipAddress,
      })
    })
  }

  /** Moves the ticket to another organization: an admin, or an agent of both organizations. */
  async move(scope: OrganizationScope, user: WorkflowUser, number: number, organizationId: string): Promise<void> {
    await transactionWithJobs(this.db, async (tx, jobs) => {
      const locked = await this.#locked(tx, scope, number)
      if (locked.organizationId === organizationId) return
      // An agent may move a ticket only into an organization they belong to; one outside the scope is not offered.
      if (!inScope(scope, organizationId)) throw new Refusal("move_not_allowed", 403)
      const names = await tx
        .select({ id: organization.id, name: organization.name })
        .from(organization)
        .where(inArray(organization.id, [locked.organizationId, organizationId]))
        .for("share")
      const target = names.find((row) => row.id === organizationId)
      if (!target) throw new Refusal("organization_not_found", 404)
      // Replies after the move come from the new organization: one with no address for this ticket (patterns alone,
      // and the ticket's support address not its own) would leave the ticket unanswerable, so it is refused.
      const [held] = await tx
        .select({ supportAddress: ticket.supportAddress })
        .from(ticket)
        .where(eq(ticket.id, locked.id))
      if (!held || fromAddresses(await supportRules(tx), organizationId, held.supportAddress).from.length === 0)
        throw new Refusal("move_no_sending_address", 409)
      await tx.update(ticket).set({ organizationId }).where(eq(ticket.id, locked.id))
      // The waiting period ends with the move (plan 4.3): its reminder was the old organization's. First, so the count
      // of cancelled scheduled replies holds only them.
      const waitingSince = await endWaitingPeriodForMove(tx, locked.id)
      // Scheduled replies were written as the old organization (its From address, its signature): cancelled.
      const cancelled = await cancelTicketActions(tx, locked.id, "move")
      // A period Maane started goes on at once under the new organization: its reminder from the new organization's
      // days, counted from now, and its template, read when it goes; none when it has no template.
      if (waitingSince)
        await openWaitingPeriod(tx, locked.id, waitingSince, (data, startAfter) =>
          this.jobs.sendIn(jobs, TIMED_ACTION, data, { startAfter }),
        )
      await writeAudit(tx, user.actor, {
        action: "ticket.move",
        entityType: "ticket",
        entityId: locked.id,
        details: {
          ticket: locked.number,
          from: { id: locked.organizationId, name: names.find((row) => row.id === locked.organizationId)?.name },
          to: { id: target.id, name: target.name },
          ...(cancelled ? { scheduledCancelled: cancelled } : {}),
        },
        ipAddress: user.ipAddress,
      })
    })
  }
}

/** A ticket's categories, by name. */
export async function categoriesOf(db: Db, ticketId: string): Promise<CategoryRef[]> {
  return db
    .select({ id: category.id, name: category.name })
    .from(ticketCategory)
    .innerJoin(category, eq(category.id, ticketCategory.categoryId))
    .where(eq(ticketCategory.ticketId, ticketId))
    .orderBy(sql`lower(${category.name})`)
}
