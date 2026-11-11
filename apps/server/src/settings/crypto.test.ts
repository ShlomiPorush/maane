import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { createSettingsCipher } from "./crypto.ts"

const key = (version: number) => ({ version, value: randomBytes(32).toString("hex") })

describe("settings cipher", () => {
  it("round-trips and binds a value to its setting", () => {
    const cipher = createSettingsCipher([key(1)])
    const stored = cipher.encrypt("mail.apiKey", "value-1")
    expect(stored).toMatch(/^v1\./)
    expect(stored).not.toContain("value-1")
    expect(cipher.decrypt("mail.apiKey", stored)).toBe("value-1")
    expect(cipher.decrypt("mail.otherKey", stored)).toBeNull()
  })

  it("decrypts with an older listed key and refuses an unlisted or damaged one", () => {
    const old = key(1)
    const stored = createSettingsCipher([old]).encrypt("k", "v")
    expect(createSettingsCipher([key(2), old]).decrypt("k", stored)).toBe("v")
    expect(createSettingsCipher([key(2)]).decrypt("k", stored)).toBeNull()
    expect(createSettingsCipher([old]).decrypt("k", `${stored.slice(0, -2)}AA`)).toBeNull()
    expect(createSettingsCipher([old]).decrypt("k", "not a value")).toBeNull()
  })
})
