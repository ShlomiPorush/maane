import { describe, expect, it } from "vitest"
import { textDirection } from "./bidi.ts"

// Hebrew and Arabic from code points: the repository holds no literal right-to-left text outside he.json.
const SHALOM = String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd)
const SALAM = String.fromCodePoint(0x633, 0x644, 0x627, 0x645)

describe("textDirection", () => {
  it("follows the first strong character", () => {
    expect(textDirection(`${SHALOM} hello`)).toBe("rtl")
    expect(textDirection(`hello ${SHALOM}`)).toBe("ltr")
    expect(textDirection(SALAM)).toBe("rtl")
    expect(textDirection(`> 12:30 - ${SHALOM}`)).toBe("rtl")
    expect(textDirection("> 12:30 - ok")).toBe("ltr")
  })

  it("gives no direction to text without a letter", () => {
    expect(textDirection("")).toBeNull()
    expect(textDirection("  123, 456 -- !")).toBeNull()
  })
})
