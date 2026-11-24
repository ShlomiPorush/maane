import { randomBytes } from "node:crypto"
import { SETTING_KEYS, SETTINGS, type SettingKey, type SettingValue, type SettingView } from "@maane/shared"
import { inArray } from "drizzle-orm"
import { type Actor, writeAudit } from "../audit.ts"
import type { Db } from "../db/client.ts"
import { setting } from "../db/schema.ts"
import { makeSourceCurrent } from "../intake/source.ts"
import type { SettingsCipher } from "./crypto.ts"

export class SettingsError extends Error {
  constructor(
    readonly code: "setting_locked" | "setting_invalid" | "setting_unknown",
    readonly key: string,
  ) {
    super(`${code}: ${key}`)
    this.name = "SettingsError"
  }
}

export class Settings {
  constructor(
    private readonly db: Db,
    private readonly cipher: SettingsCipher,
    private readonly overrides: Partial<Record<SettingKey, string>>,
  ) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const values = await this.#effective([key])
    return values.get(key)?.value as SettingValue<K>
  }

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
        variable: locked ? (definition.env?.name ?? null) : null,
      }
    })
  }

  async update(changes: Record<string, unknown>, actor: Actor, ipAddress: string | null = null): Promise<void> {
    const rows: { key: SettingKey; value: unknown; ciphertext: string | null }[] = []
    for (const [key, raw] of Object.entries(changes)) {
      if (!(key in SETTINGS)) throw new SettingsError("setting_unknown", key)
      const settingKey = key as SettingKey
      const definition = SETTINGS[settingKey]
      if (this.overrides[settingKey] !== undefined) throw new SettingsError("setting_locked", key)
      if (definition.generated) throw new SettingsError("setting_invalid", key)
      const parsed = definition.schema.safeParse(raw)
      if (!parsed.success) throw new SettingsError("setting_invalid", key)
      rows.push(
        definition.secret
          ? { key: settingKey, value: null, ciphertext: this.cipher.encrypt(key, JSON.stringify(parsed.data)) }
          : { key: settingKey, value: parsed.data, ciphertext: null },
      )
    }
    await this.db.transaction(async (tx) => {
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

  async generate<K extends SettingKey>(
    keys: K[],
    actor: Actor,
    ipAddress: string | null = null,
  ): Promise<Record<K, string>> {
    const values = {} as Record<K, string>
    for (const key of keys) {
      if (!SETTINGS[key].generated) throw new SettingsError("setting_invalid", key)
      values[key] = randomBytes(32).toString("base64url")
    }
    await this.db.transaction(async (tx) => {
      for (const key of keys) {
        const ciphertext = this.cipher.encrypt(key, JSON.stringify(values[key]))
        await tx
          .insert(setting)
          .values({ key, value: null, ciphertext, updatedBy: actor.label })
          .onConflictDoUpdate({
            target: setting.key,
            set: { value: null, ciphertext, updatedAt: new Date(), updatedBy: actor.label },
          })
        await writeAudit(tx, actor, {
          action: "setting.update",
          entityType: "setting",
          entityId: key,
          details: { secret: true, generated: true },
          ipAddress,
        })
      }
    })
    return values
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
          value: definition.schema.parse(definition.env ? definition.env.parse(override) : override),
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
