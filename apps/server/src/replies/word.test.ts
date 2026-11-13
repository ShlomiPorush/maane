import { describe, expect, it } from "vitest"
import { withoutComments as visible } from "../testing/comments.ts"
import { cutForWord, LONG_RUN, wordCopies } from "./word.ts"

describe("Word's copy of a long run (html-email, long values without spaces)", () => {
  const token = `https://www.example.com/?q=${"A1&b".repeat(44)}`

  it("cuts a 200-character token into lines for Word, and leaves the text every other client shows unchanged", () => {
    expect([...token].length).toBeGreaterThanOrEqual(200)
    const html = wordCopies(`<p>Track: ${token.replaceAll("&", "&amp;")} today</p>`)
    const word = /<!--\[if mso\]>([\s\S]*?)<!\[endif\]-->/.exec(html)?.[1] ?? ""
    expect(word.split("<br>").length).toBe(Math.ceil([...token].length / LONG_RUN))
    // Cut before escaping: the pieces joined again are the token, and no entity is split.
    expect(word.replaceAll("<br>", "").replace("Track: ", "").replace(" today", "")).toBe(
      token.replaceAll("&", "&amp;"),
    )
    expect(html).toContain("<!--[if !mso]><!-->")
    expect(visible(html)).toBe(`<p>Track: ${token.replaceAll("&", "&amp;")} today</p>`)
  })

  it("leaves text without a long run as it is, and cuts between code points", () => {
    expect(wordCopies("<p>Short words only.</p>")).toBe("<p>Short words only.</p>")
    const emoji = String.fromCodePoint(0x1f600).repeat(LONG_RUN + 1)
    expect(
      cutForWord(emoji)
        .split("<br>")
        .map((line) => [...line].length),
    ).toEqual([LONG_RUN, 1])
  })
})
