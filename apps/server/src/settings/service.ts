import { SETTING_KEYS, SETTINGS, type SettingKey, type SettingValue, type SettingView } from "@maane/shared"
import { inArray } from "drizzle-orm"
import { type Actor, writeAudit } from "../audit.ts"
import type { Db } from "../db/client.ts"
import { setting } from "../db/schema.ts"
import { makeSourceCurrent } from "../intake/source.ts"
import { checkIntakeModeChange } from "../organizations/intake.ts"
import type { SettingsCipher } from "./crypto.ts"

/** A refusal the API maps to a stable error code. */
export class SettingsError extends Error {
  constructor(
    readonly code: "setting_locked" | "setting_invalid" | "setting_unknown",
    readonly key: string,
  ) {
    super(`${code}: ${key}`)
    this.name = "SettingsError"
  }
}

/**
 * The settings the owner manages: the environment first, per field, then the stored value, then the default. A
 * field the environment sets is locked: changes are refused and the UI names the variable.
 */
export class Settings {
  constructor(
    private readonly db: Db,
    private readonly cipher: SettingsCipher,
    private readonly overrides: Partial<Record<SettingKey, string>>,
  ) {}

  /** The value in effect. A secret that cannot be decrypted (its key version is gone) reads as its default. */
  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const values = await this.#effective([key])
    return values.get(key)?.value as SettingValue<K>
  }

  /** Every setting as the API shows it: a secret only says whether it is set. */
  async view(): Promise<SettingView[]> {
    const values = await this.#effective(SETTING_KEYS)
    return SETTING_KEYS.map((key) => {
      const definition = SETTINGS[key]
      const effective = values.get(key)
      const locked = this.overrides[key] !== undefined
      return {
        key,
        value: definition.secret ? null : (effective?.value ?? definition.defaultValue),
        secret: definition.secret,
        set: effective?.source !== "default",
        locked,
        variable: locked ? definition.env : null,
      }
    })
  }

  /**
   * Stores changes in one transaction with one audit row each. Refuses a locked field, an unknown key, or a value
   * that does not validate, before anything is written. A new intake mode first takes the intake configuration lock
   * and is refused as live while no default address exists (organizations/intake.ts). A new Graph tenant or mailbox
   * makes the matching intake source current in the same transaction, after it locked the current one (intake/source.ts).
   */
  async update(changes: Record<string, unknown>, actor: Actor, ipAddress: string | null = null): Promise<void> {
    const rows: { key: SettingKey; value: unknown; ciphertext: string | null }[] = []
    for (const [key, raw] of Object.entries(changes)) {
      if (!(key in SETTINGS)) throw new SettingsError("setting_unknown", key)
      const settingKey = key as SettingKey
      const definition = SETTINGS[settingKey]
      if (this.overrides[settingKey] !== undefined) throw new SettingsError("setting_locked", key)
      const parsed = definition.schema.safeParse(raw)
      if (!parsed.success) throw new SettingsError("setting_invalid", key)
      rows.push(
        definition.secret
          ? { key: settingKey, value: null, ciphertext: this.cipher.encrypt(key, JSON.stringify(parsed.data)) }
          : { key: settingKey, value: parsed.data, ciphertext: null },
      )
    }
    await this.db.transaction(async (tx) => {
      const mode = rows.find((row) => row.key === "intake.mode")
      if (mode) await checkIntakeModeChange(tx, mode.value as SettingValue<"intake.mode">)
      for (const row of rows) {
        await tx
          .insert(setting)
          .values({ key: row.key, value: row.value, ciphertext: row.ciphertext, updatedBy: actor.label })
          .onConflictDoUpdate({
            target: setting.key,
            set: { value: row.value, ciphertext: row.ciphertext, updatedAt: new Date(), updatedBy: actor.label },
          })
        await writeAudit(tx, actor, {
          action: "setting.update",
          entityType: "setting",
          entityId: row.key,
          details: SETTINGS[row.key].secret ? { secret: true } : { value: row.value },
          ipAddress,
        })
      }
      if (rows.some((row) => row.key === "graph.tenantId" || row.key === "graph.mailbox")) {
        const values = await this.#effective(["graph.tenantId", "graph.mailbox"], tx)
        await makeSourceCurrent(
          tx,
          String(values.get("graph.tenantId")?.value ?? ""),
          String(values.get("graph.mailbox")?.value ?? ""),
        )
      }
    })
  }

  async #effective(
    keys: SettingKey[],
    db: Pick<Db, "select"> = this.db,
  ): Promise<Map<SettingKey, { value: unknown; source: string }>> {
    const stored = await db.select().from(setting).where(inArray(setting.key, keys))
    const byKey = new Map(stored.map((row) => [row.key, row]))
    const result = new Map<SettingKey, { value: unknown; source: string }>()
    for (const key of keys) {
      const definition = SETTINGS[key]
      const override = this.overrides[key]
      if (override !== undefined) {
        result.set(key, {
          value: definition.schema.parse(definition.fromEnv ? definition.fromEnv(override) : override),
          source: "env",
        })
        continue
      }
      const row = byKey.get(key)
      let value: unknown
      if (row?.ciphertext) {
        const plain = this.cipher.decrypt(key, row.ciphertext)
        const parsed = plain === null ? undefined : definition.schema.safeParse(JSON.parse(plain))
        value = parsed?.success ? parsed.data : undefined
      } else if (row) {
        const parsed = definition.schema.safeParse(row.value)
        value = parsed.success ? parsed.data : undefined
      }
      result.set(
        key,
        value === undefined ? { value: definition.defaultValue, source: "default" } : { value, source: "db" },
      )
    }
    return result
  }
}
