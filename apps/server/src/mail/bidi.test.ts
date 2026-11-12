import { describe, expect, it } from "vitest"
import { textDirection } from "./bidi.ts"

// Every right-to-left letter and every control character from code points: the repository holds no literal Hebrew
// outside he.json and no literal bidirectional control.
const cp = (...points: number[]) => String.fromCodePoint(...points)
const SHALOM = cp(0x5e9, 0x5dc, 0x5d5, 0x5dd)
const SALAM = cp(0x633, 0x644, 0x627, 0x645)
const RLM = cp(0x200f)
const LRM = cp(0x200e)
const ARABIC_INDIC_ONE = cp(0x661)
const RLI = cp(0x2067)
const PDI = cp(0x2069)

describe("textDirection (UAX #9 P2, P3)", () => {
  it("follows the first character of class L, R, or AL", () => {
    expect(textDirection(`${SHALOM} hello`)).toBe("rtl")
    expect(textDirection(`hello ${SHALOM}`)).toBe("ltr")
    expect(textDirection(SALAM)).toBe("rtl")
  })

  it("reads the marks as strong: a right-to-left mark first is right to left, a left-to-right mark first left to right", () => {
    expect(textDirection(`${RLM}hello`)).toBe("rtl")
    expect(textDirection(`${LRM}${SHALOM}`)).toBe("ltr")
  })

  it("skips weak and neutral characters: numbers, Arabic-Indic digits, punctuation", () => {
    expect(textDirection(`${ARABIC_INDIC_ONE}hello`)).toBe("ltr")
    expect(textDirection(`2026-11-12, ${SHALOM}`)).toBe("rtl")
    expect(textDirection(`> (12:30) -- ${SHALOM}`)).toBe("rtl")
    expect(textDirection("> (12:30) -- ok")).toBe("ltr")
  })

  it("skips what an isolate holds", () => {
    expect(textDirection(`${RLI}${SHALOM}${PDI} hello`)).toBe("ltr")
    // An isolate left open ends with its paragraph.
    expect(textDirection(`${RLI}${SHALOM}\nhello`)).toBe("ltr")
  })

  it("gives no direction to text without a strong character", () => {
    expect(textDirection("")).toBeNull()
    expect(textDirection("  123, 456 -- !")).toBeNull()
    expect(textDirection(ARABIC_INDIC_ONE)).toBeNull()
  })
})
