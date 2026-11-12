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
    expect(patternMatches("*@example.com", "a@example.com.mail.example.com")).toBe(false)
    // Characters that mean something in a regular expression are literal in a pattern.
    expect(patternMatches("a+*@example.com", "a+b@example.com")).toBe(true)
    expect(patternMatches("a+*@example.com", "aab@example.com")).toBe(false)
    expect(patternMatches("*@example.com", "a@exampleXcom")).toBe(false)
  })

  it("decides a pathological pattern at once, where a regular expression would backtrack for ages", () => {
    const pattern = `${"a*".repeat(20)}b@example.com`
    const address = `${"a".repeat(64)}@example.com`
    expect(parsePattern(pattern).ok).toBe(true)
    expect(parseExactAddress(address).ok).toBe(true)
    const started = performance.now()
    for (let round = 0; round < 20; round++) {
      expect(patternMatches(pattern, address)).toBe(false)
      expect(matchSupportAddress(address, [{ kind: "pattern", value: pattern, isDefault: false }])).toBeNull()
    }
    // Twenty rounds of the worst case take a few milliseconds; the regular expression took minutes for one.
    expect(performance.now() - started).toBeLessThan(500)
    expect(patternMatches(pattern, `${"a".repeat(62)}b@example.com`)).toBe(true)
  })

  it("matches exactly as a star of one or more non-@ characters, on every small case", () => {
    // The definition, as a regular expression: fine for these short texts, and independent of the matcher.
    const reference = (p: string, a: string) =>
      new RegExp(
        `^${p
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"))
          .join("[^@]+")}$`,
      ).test(a)
    const alphabet = ["a", "b", "@", "*"]
    const texts = (length: number, withStar: boolean): string[] => {
      if (length === 0) return [""]
      const shorter = texts(length - 1, withStar)
      return alphabet.filter((c) => withStar || c !== "*").flatMap((c) => shorter.map((rest) => c + rest))
    }
    const patterns = [0, 1, 2, 3, 4].flatMap((n) => texts(n, true))
    const addresses = [0, 1, 2, 3, 4, 5].flatMap((n) => texts(n, false))
    let compared = 0
    for (const p of patterns)
      for (const a of addresses) {
        expect(patternMatches(p, a), `${p} ~ ${a}`).toBe(reference(p, a))
        compared++
      }
    expect(compared).toBeGreaterThan(100_000)
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
  const rules = [exact("help@example.com", true), exact("sales@example.com"), pattern("*@two.example.com")]

  it("takes the first address that matches, in the order given (To, then Cc)", () => {
    expect(resolveSupportAddress(["someone@elsewhere.example.com", "Sales@example.com"], rules)).toEqual({
      via: "exact",
      address: "sales@example.com",
      rule: rules[1],
    })
    expect(resolveSupportAddress(["x@two.example.com", "sales@example.com"], rules)).toMatchObject({
      via: "pattern",
      address: "x@two.example.com",
    })
  })

  it("falls back to the default address, and to none without one", () => {
    expect(resolveSupportAddress(["someone@elsewhere.example.com"], rules)).toEqual({ via: "default", rule: rules[0] })
    expect(resolveSupportAddress(["someone@elsewhere.example.com"], rules.slice(1))).toEqual({ via: "none" })
  })
})
