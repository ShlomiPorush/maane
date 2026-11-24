import { eq, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { supportAddress } from "../db/schema.ts"

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export const INTAKE_CONFIG_LOCK = "intake-config"

export async function lockIntakeConfig(tx: Pick<Tx, "execute">): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${INTAKE_CONFIG_LOCK}, 0))`)
}

export async function hasDefaultAddress(tx: Pick<Tx, "select">): Promise<boolean> {
  const [row] = await tx
    .select({ id: supportAddress.id })
    .from(supportAddress)
    .where(eq(supportAddress.isDefault, true))
    .limit(1)
  return row !== undefined
}
