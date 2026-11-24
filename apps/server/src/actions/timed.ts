import type { ActionReason, ActionState } from "@maane/shared"
import { and, eq, inArray, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { timedAction } from "../db/schema.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

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

export const OPEN_ACTION_STATES = ["scheduled", "handed"] as const satisfies readonly ActionState[]

export function actionPassed(action: { state: string; version: number } | null, version: number | null): boolean {
  return action?.state === "done" && action.version === version
}

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

export async function ticketOfAction(tx: Pick<Tx, "select">, id: string): Promise<string | null> {
  const [row] = await tx.select({ ticketId: timedAction.ticketId }).from(timedAction).where(eq(timedAction.id, id))
  return row?.ticketId ?? null
}

export async function setActionState(
  tx: Pick<Tx, "update">,
  id: string,
  state: ActionState,
  reason: ActionReason | null = null,
): Promise<void> {
  await tx.update(timedAction).set({ state, reason, updatedAt: sql`now()` }).where(eq(timedAction.id, id))
}

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
