// The intake configuration rule (plan 2.1; phase 6): mail becomes tickets only while a default address exists, and once
// one exists it can only be replaced, never removed. Every change that could touch the default (setting the default,
// removing an address) takes one transaction-scoped advisory lock first and then reads the default inside the same
// transaction. While no default exists, stage two of intake processes nothing (apps/worker/src/intake/process.ts).

import { eq, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { supportAddress } from "../db/schema.ts"

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** The name of the advisory lock; PostgreSQL keys it by the 64-bit hash of this text. */
export const INTAKE_CONFIG_LOCK = "intake-config"

/** Waits for, then holds until the transaction ends, the one lock every intake configuration change takes. */
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
