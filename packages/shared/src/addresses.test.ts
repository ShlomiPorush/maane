import { describe, expect, it } from "vitest"
import {
  compareBytes,
  literalCount,
  matchSupportAddress,
  parseExactAddress,
  parsePattern,
  patternMatches,
  resolveSupportAddress,
} from "./addresses.ts"

const exact = (value: string, isDefault = false) => ({ kind: "exact" as const, value, isDefault })
const pattern = (value: string) => ({ kind: "pattern" as const, value, isDefault: false })

describe("exact addresses", () => {
  it("stores an address trimmed and in lower case", () => {
    expect(parseExactAddress("  Support@Example.COM ")).toEqual({ ok: true, value: "support@example.com" })
    expect(parseExactAddress("first.last+tag@mail.example.com")).toEqual({
      ok: true,
      value: "first.last+tag@mail.example.com",
    })
  })

  it("refuses anything that is not one plain address", () => {
    for (const text of [
      "",
      "support",
      "@example.com",
      "support@",
      "support@example",
      "a@b@example.com",
      "sup port@example.com",
      ".support@example.com",
      "sup..port@example.com",
      "support.@example.com",
      "*@example.com",
      "support@-example.com",
      "support@example..com",
      '"quoted"@example.com',
      `${"a".repeat(65)}@example.com`,
      `a@${"b".repeat(250)}.com`,
      `support@exa${String.fromCodePoint(0x5d0)}mple.com`,
    ])
      expect(parseExactAddress(text), text).toEqual({ ok: false, code: "address_invalid" })
  })
})

describe("patterns", () => {
  it("accepts a whole address with stars in its local part only", () => {
    for (const text of ["*@example.com", "support-*@example.com", "*.help@example.com", "a*b*c@example.com"])
      expect(parsePattern(text), text).toEqual({ ok: true, value: text })
    expect(parsePattern(" *@Example.com ")).toEqual({ ok: true, value: "*@example.com" })
  })

  it("refuses every other syntax with a field error", () => {
    for (const text of [
      "support@example.com",
      "*",
      "*@*.example.com",
      "support@*",
      "**@example.com",
      "*@",
      "*@example",
      "*@@example.com",
      "?@example.com",
      "[a-z]@example.com",
      "sup port*@example.com",
      ".*@example.com",
      "*..x@example.com",
    ])
      expect(parsePattern(text), text).toEqual({ ok: false, code: "pattern_invalid" })
  })

  it("matches one or more characters that are not @ for each star", () => {
    expect(patternMatches("*@example.com", "a@example.com")).toBe(true)
    expect(patternMatches("support-*@example.com", "support-billing@example.com")).toBe(true)
    expect(patternMatches("support-*@example.com", "support-@example.com")).toBe(false)
    expect(patternMatches("*@example.com", "a@sub.example.com")).toBe(false)
    expect(patternMatches("*@example.com", "a@example.com.evil.example")).toBe(false)
    // Characters that mean something in a regular expression are literal in a pattern.
    expect(patternMatches("a+*@example.com", "a+b@example.com")).toBe(true)
    expect(patternMatches("a+*@example.com", "aab@example.com")).toBe(false)
    expect(patternMatches("*@example.com", "a@exampleXcom")).toBe(false)
  })

  it("counts literal characters", () => {
    expect(literalCount("*@example.com")).toBe(12)
    expect(literalCount("support-*@example.com")).toBe(20)
    expect(literalCount("a*b*@example.com")).toBe(14)
  })
})

describe("match order", () => {
  it("prefers an exact address over any pattern", () => {
    const rules = [pattern("support-*@example.com"), exact("support-vip@example.com"), pattern("*@example.com")]
    expect(matchSupportAddress("Support-VIP@example.com", rules)).toEqual({ via: "exact", rule: rules[1] })
  })

  it("prefers the pattern with more literal characters", () => {
    const rules = [pattern("*@example.com"), pattern("support-*@example.com"), pattern("s*@example.com")]
    expect(matchSupportAddress("support-billing@example.com", rules)?.rule.value).toBe("support-*@example.com")
    expect(matchSupportAddress("sales@example.com", rules)?.rule.value).toBe("s*@example.com")
    expect(matchSupportAddress("info@example.com", rules)?.rule.value).toBe("*@example.com")
  })

  it("breaks a tie by the pattern text in byte order, whatever order the rules come in", () => {
    // Both have 13 literal characters and both match "ab@example.com".
    const a = pattern("a*@example.com")
    const b = pattern("*b@example.com")
    expect(literalCount(a.value)).toBe(literalCount(b.value))
    const first = compareBytes(a.value, b.value) < 0 ? a : b
    expect(first).toBe(b) // "*" (0x2a) sorts before "a" (0x61)
    expect(matchSupportAddress("ab@example.com", [a, b])?.rule).toBe(b)
    expect(matchSupportAddress("ab@example.com", [b, a])?.rule).toBe(b)
  })

  it("compares by bytes, not by the locale's collation", () => {
    expect(compareBytes("B", "a")).toBeLessThan(0)
    expect(compareBytes("ab", "a")).toBeGreaterThan(0)
    expect(compareBytes("same", "same")).toBe(0)
  })

  it("matches nothing for a value that is not an address", () => {
    expect(matchSupportAddress("not an address", [pattern("*@example.com")])).toBeNull()
  })
})

describe("resolving a message's support address", () => {
  const rules = [exact("help@example.com", true), exact("sales@example.com"), pattern("*@example.org")]

  it("takes the first address that matches, in the order given (To, then Cc)", () => {
    expect(resolveSupportAddress(["someone@example.net", "Sales@example.com"], rules)).toEqual({
      via: "exact",
      address: "sales@example.com",
      rule: rules[1],
    })
    expect(resolveSupportAddress(["x@example.org", "sales@example.com"], rules)).toMatchObject({
      via: "pattern",
      address: "x@example.org",
    })
  })

  it("falls back to the default address, and to none without one", () => {
    expect(resolveSupportAddress(["someone@example.net"], rules)).toEqual({ via: "default", rule: rules[0] })
    expect(resolveSupportAddress(["someone@example.net"], rules.slice(1))).toEqual({ via: "none" })
  })
})
