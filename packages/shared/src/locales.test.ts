import { describe, expect, it } from "vitest"
import { DEFAULT_LOCALE, direction, LOCALES, MESSAGES } from "./locales.ts"

function keys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key))
}

describe("locales", () => {
  it("defaults to Hebrew, written right to left", () => {
    expect(DEFAULT_LOCALE).toBe("he")
    expect(direction("he")).toBe("rtl")
    expect(direction("en")).toBe("ltr")
  })

  it("has the same keys in every locale", () => {
    const [first, ...rest] = LOCALES.map((locale) => keys(MESSAGES[locale]).sort())
    for (const other of rest) expect(other).toEqual(first)
  })

  it("holds Hebrew text in the Hebrew locale only", () => {
    // The Hebrew block, U+0590 to U+05FF, built from code points: Hebrew stays out of source files.
    const hebrew = new RegExp(`[${String.fromCodePoint(0x590)}-${String.fromCodePoint(0x5ff)}]`)
    expect(MESSAGES.he.app.name).toMatch(hebrew)
    expect(MESSAGES.en.app.name).not.toMatch(hebrew)
  })
})
