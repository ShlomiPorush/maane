import type { Db } from "./db/client.ts"
import { auditLog } from "./db/schema.ts"

/** Who did something: a signed-in user, or the system (the worker, a scheduled job). */
export type Actor = { userId: string; label: string } | { userId: null; label: "system" }

export const SYSTEM: Actor = { userId: null, label: "system" }

export interface AuditEntry {
  action: string
  entityType?: string
  entityId?: string | null
  /** Facts about the change. Never a secret value: a secret setting records only that it changed. */
  details?: Record<string, unknown>
  ipAddress?: string | null
}

/**
 * Writes one audit row. Pass the transaction of the change, so the row and the change commit or roll back together.
 * Better Auth's own writes are recorded from its hooks on Maane's connection instead (see "Foundation 1b design").
 */
export async function writeAudit(db: Pick<Db, "insert">, actor: Actor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    details: entry.details ?? null,
    ipAddress: entry.ipAddress ?? null,
  })
}
