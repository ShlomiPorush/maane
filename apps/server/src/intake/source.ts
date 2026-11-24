import { and, eq, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { intakeSource } from "../db/schema.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export type IntakeSource = typeof intakeSource.$inferSelect

export const sourceKey = (tenantId: string, mailbox: string) => ({
  tenantId: tenantId.trim().toLowerCase(),
  mailbox: mailbox.trim().toLowerCase(),
})

export async function lockCurrentSourceForChange(tx: Tx): Promise<IntakeSource | null> {
  const [row] = await tx.select().from(intakeSource).where(eq(intakeSource.current, true)).for("update")
  return row ?? null
}

export async function makeSourceCurrent(tx: Tx, tenantId: string, mailbox: string): Promise<IntakeSource | null> {
  const key = sourceKey(tenantId, mailbox)
  const current = await lockCurrentSourceForChange(tx)
  const complete = key.tenantId !== "" && key.mailbox !== ""
  if (current && complete && current.tenantId === key.tenantId && current.mailbox === key.mailbox) return current
  if (current) await tx.update(intakeSource).set({ current: false }).where(eq(intakeSource.id, current.id))
  if (!complete) return null
  await tx
    .insert(intakeSource)
    .values({ ...key })
    .onConflictDoNothing({ target: [intakeSource.tenantId, intakeSource.mailbox] })
  const [made] = await tx
    .update(intakeSource)
    .set({ current: true })
    .where(and(eq(intakeSource.tenantId, key.tenantId), eq(intakeSource.mailbox, key.mailbox)))
    .returning()
  return made ?? null
}

export async function holdSourceIfCurrent(tx: Pick<Tx, "execute">, sourceId: string): Promise<boolean> {
  const result = await tx.execute(sql`select current from intake_source where id = ${sourceId} for share`)
  const row = result.rows[0] as { current?: boolean } | undefined
  return row?.current === true
}
