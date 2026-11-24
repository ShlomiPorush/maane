import type { Db } from "./db/client.ts"
import { auditLog } from "./db/schema.ts"

export type Actor = { userId: string; label: string } | { userId: null; label: "system" }

export const SYSTEM: Actor = { userId: null, label: "system" }

export interface AuditEntry {
  action: string
  entityType?: string
  entityId?: string | null
  details?: Record<string, unknown>
  ipAddress?: string | null
}

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
