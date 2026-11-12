// The intake configuration rule (plan 2.1, P17): while the intake mode is live, a default address must exist. Every
// change that could break it (switching the mode, setting the default, removing an address) takes one
// transaction-scoped advisory lock first and then reads the mode and the default inside the same transaction, so a
// switch to live and the removal of the default at the same moment cannot both pass.

import { type IntakeMode, SETTINGS } from "@maane/shared"
import { eq, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { setting, supportAddress } from "../db/schema.ts"
import { Refusal } from "./refusal.ts"

/** A transaction of Maane's connection. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** The name of the advisory lock; PostgreSQL keys it by the 64-bit hash of this text. */
export const INTAKE_CONFIG_LOCK = "intake-config"

/** Waits for, then holds until the transaction ends, the one lock every intake configuration change takes. */
export async function lockIntakeConfig(tx: Pick<Tx, "execute">): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${INTAKE_CONFIG_LOCK}, 0))`)
}

/** The intake mode as stored (no variable can set it); the default when the row holds nothing valid. */
export async function intakeModeIn(tx: Pick<Tx, "select">): Promise<IntakeMode> {
  const [row] = await tx.select({ value: setting.value }).from(setting).where(eq(setting.key, "intake.mode"))
  const parsed = SETTINGS["intake.mode"].schema.safeParse(row?.value)
  return parsed.success ? parsed.data : SETTINGS["intake.mode"].defaultValue
}

export async function hasDefaultAddress(tx: Pick<Tx, "select">): Promise<boolean> {
  const [row] = await tx
    .select({ id: supportAddress.id })
    .from(supportAddress)
    .where(eq(supportAddress.isDefault, true))
    .limit(1)
  return row !== undefined
}

/**
 * Called by the settings service inside the transaction that stores a new intake mode, before it writes: takes the
 * lock, and refuses live while no default address exists.
 */
export async function checkIntakeModeChange(tx: Tx, mode: IntakeMode): Promise<void> {
  await lockIntakeConfig(tx)
  if (mode === "live" && !(await hasDefaultAddress(tx)))
    throw new Refusal("intake_no_default_address", 409, { key: "intake.mode" })
}
