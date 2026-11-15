// One rule for every timed action (plan 4.2, requirements 2.3). A timed action is one row with a version
// (`timed_action`); every change moves the version on, and its job names the version it was queued for, so the job of
// a replaced or cancelled version does nothing. At its time the job checks, under the ticket's lock and then the
// action's, that the action still applies, and makes at most one outbox row for its version (a unique index); the send
// point checks it once more in the transaction that hands that row to `sending` (apps/worker/src/send/sender.ts). A
// customer reply and a move to another organization cancel the ticket's actions in their own transaction.
//
// Lock order: the ticket, then the action, on every path (an outbox row, when there is one, before both, as the send
// point's claim takes them). Kept free of sharp: the worker loads it.

import type { ActionReason, ActionState } from "@maane/shared"
import { and, eq, inArray, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { timedAction } from "../db/schema.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** A timed action locked FOR UPDATE until the transaction ends. */
export type LockedAction = {
  id: string
  kind: string
  ticketId: string
  authorUserId: string | null
  version: number
  state: ActionState
  reason: ActionReason | null
  dueAt: Date
}

/** The states in which an action has not sent anything yet and can still be cancelled by the system. */
export const OPEN_ACTION_STATES = ["scheduled", "handed"] as const satisfies readonly ActionState[]

/** The action locked FOR UPDATE, or null. Its ticket must be locked first. */
export async function lockAction(tx: Pick<Tx, "select">, id: string): Promise<LockedAction | null> {
  const [row] = await tx
    .select({
      id: timedAction.id,
      kind: timedAction.kind,
      ticketId: timedAction.ticketId,
      authorUserId: timedAction.authorUserId,
      version: timedAction.version,
      state: timedAction.state,
      reason: timedAction.reason,
      dueAt: timedAction.dueAt,
    })
    .from(timedAction)
    .where(eq(timedAction.id, id))
    .for("update")
  return row ? { ...row, state: row.state as ActionState, reason: row.reason as ActionReason | null } : null
}

/** The ticket an action belongs to (read without a lock: the caller locks the ticket, then the action). */
export async function ticketOfAction(tx: Pick<Tx, "select">, id: string): Promise<string | null> {
  const [row] = await tx.select({ ticketId: timedAction.ticketId }).from(timedAction).where(eq(timedAction.id, id))
  return row?.ticketId ?? null
}

/** Moves a locked action to a new state (and reason), by the database's clock. */
export async function setActionState(
  tx: Pick<Tx, "update">,
  id: string,
  state: ActionState,
  reason: ActionReason | null = null,
): Promise<void> {
  await tx.update(timedAction).set({ state, reason, updatedAt: sql`now()` }).where(eq(timedAction.id, id))
}

/**
 * Cancels every action of a ticket that has not sent anything yet (scheduled, or handed and not yet at the send
 * point), in the caller's transaction, which holds the ticket locked: a customer reply (in the transaction that attaches
 * it) and a move to another organization (in the move's). Returns how many it cancelled.
 */
export async function cancelTicketActions(
  tx: Pick<Tx, "update">,
  ticketId: string,
  reason: Extract<ActionReason, "customer_reply" | "move">,
): Promise<number> {
  const cancelled = await tx
    .update(timedAction)
    .set({ state: "cancelled", reason, updatedAt: sql`now()` })
    .where(and(eq(timedAction.ticketId, ticketId), inArray(timedAction.state, [...OPEN_ACTION_STATES])))
    .returning({ id: timedAction.id })
  return cancelled.length
}
