import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import type { VersionedKey } from "../config.ts"

const IV_BYTES = 12
const TAG_BYTES = 16

export type SettingsCipher = {
  encrypt(settingKey: string, plain: string): string
  decrypt(settingKey: string, stored: string): string | null
}

const derive = (value: string) => Buffer.from(hkdfSync("sha256", value, "maane", "settings-secret", 32))

export function createSettingsCipher(keys: VersionedKey[]): SettingsCipher {
  const [current] = keys
  if (!current) throw new Error("at least one settings key is required")
  const derived = new Map(keys.map((k) => [k.version, derive(k.value)]))
  return {
    encrypt(settingKey, plain) {
      const key = derived.get(current.version) as Buffer
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      cipher.setAAD(Buffer.from(settingKey, "utf8"))
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()])
      return `v${current.version}.${iv.toString("base64url")}.${body.toString("base64url")}`
    },
    decrypt(settingKey, stored) {
      const match = /^v(\d{1,6})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(stored)
      if (!match) return null
      const key = derived.get(Number(match[1]))
      if (!key) return null
      const iv = Buffer.from(match[2] ?? "", "base64url")
      const body = Buffer.from(match[3] ?? "", "base64url")
      if (iv.length !== IV_BYTES || body.length < TAG_BYTES) return null
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv)
        decipher.setAAD(Buffer.from(settingKey, "utf8"))
        decipher.setAuthTag(body.subarray(body.length - TAG_BYTES))
        const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()])
        return plain.toString("utf8")
      } catch {
        return null
      }
    },
  }
}
