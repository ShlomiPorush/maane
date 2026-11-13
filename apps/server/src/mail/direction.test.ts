import { describe, expect, it } from "vitest"
import { directBlocks, messageDirection } from "./direction.ts"
import { renderMailHtml, sanitizeMailHtml } from "./html.ts"

// Hebrew and controls from code points: the repository holds no literal Hebrew outside he.json and no literal
// bidirectional control.
const cp = (...points: number[]) => String.fromCodePoint(...points)
const SHALOM = cp(0x5e9, 0x5dc, 0x5d5, 0x5dd)
const TODA = cp(0x5ea, 0x5d5, 0x5d3, 0x5d4)
const RLM = cp(0x200f)
const IMAGE = '<img src="cid:logo@example.com" alt="logo" width="120" height="40" />'

/** Every `dir` the HTML holds, in document order. */
const dirs = (html: string) => [...html.matchAll(/<(\w+)[^>]*?\sdir="([^"]*)"/g)].map((m) => `${m[1]}:${m[2]}`)

describe("directBlocks", () => {
  it("gives each block the direction of its first strong character", () => {
    const html = directBlocks(`<p>${SHALOM} hello</p><p>hello ${SHALOM}</p><div>2026 - ${TODA}</div>`, "rtl")
    expect(dirs(html)).toEqual(["p:rtl", "p:ltr", "div:rtl"])
  })

  it("gives a block without a strong character the direction around it: an image alone in a Hebrew message", () => {
    expect(dirs(directBlocks(`<p>${SHALOM}</p><p>${IMAGE}</p><p>12:30</p>`, "rtl"))).toEqual([
      "p:rtl",
      "p:rtl",
      "p:rtl",
    ])
    expect(dirs(directBlocks(`<p>hello</p><div>${IMAGE}</div>`, "ltr"))).toEqual(["p:ltr", "div:ltr"])
    // Nested: a block inside an English block keeps the English block's direction when it has no letter.
    expect(dirs(directBlocks(`<div>hello<div>${IMAGE}</div></div>`, "rtl"))).toEqual(["div:ltr", "div:ltr"])
  })

  it("replaces dir=auto everywhere, also inline and inside a block the sender directed", () => {
    const html = directBlocks(
      `<p dir="auto">${SHALOM}</p><p dir="auto">English</p><div dir="ltr"><span dir="auto">${SHALOM}</span></div>`,
      "rtl",
    )
    expect(html).not.toContain('dir="auto"')
    expect(dirs(html)).toEqual(["p:rtl", "p:ltr", "div:ltr", "span:rtl"])
  })

  it("keeps the sender's direction and leaves the blocks inside it to inherit it", () => {
    const html = directBlocks(`<div dir="ltr"><p>${SHALOM}</p></div><p style="direction:ltr">${SHALOM}</p>`, "rtl")
    expect(dirs(html)).toEqual(["div:ltr"])
    expect(html).toContain(`<p style="direction:ltr">${SHALOM}</p>`)
  })

  it("skips what a descendant with its own direction holds, as HTML isolates it", () => {
    expect(dirs(directBlocks(`<p><span dir="ltr">ABCD-1234</span>: ${SHALOM}</p>`, "ltr"))).toEqual([
      "p:rtl",
      "span:ltr",
    ])
    // A right-to-left mark is strong.
    expect(dirs(directBlocks(`<p>${RLM}2026-11-13</p>`, "ltr"))).toEqual(["p:rtl"])
  })

  it("directs lists and cells, and leaves tables to inherit", () => {
    const html = directBlocks(
      `<ul><li>${SHALOM}</li><li>one</li></ul><table><tr><td>${SHALOM}</td><td>two</td></tr></table>`,
      "ltr",
    )
    expect(dirs(html)).toEqual(["ul:rtl", "li:rtl", "li:ltr", "td:rtl", "td:ltr"])
  })

  it("changes nothing else: text, entities, and attributes survive the round trip and the allow list", () => {
    const stored = sanitizeMailHtml(
      `<p>a &amp; b &lt;c&gt; ${SHALOM}&nbsp;"q"</p><p><a href="https://example.com/?a=1&amp;b=2">x</a></p>`,
    )
    const html = directBlocks(stored, "ltr")
    expect(html).toContain(`a &amp; b &lt;c&gt; ${SHALOM}`)
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"')
    const served = renderMailHtml(html, { remoteImages: false, inline: () => null }).html
    expect(dirs(served)).toEqual(["p:ltr", "p:ltr"])
    expect(served).toContain(`a &amp; b &lt;c&gt; ${SHALOM}`)
  })
})

describe("messageDirection", () => {
  it("takes the text's first strong character, then the HTML's, then the fallback", () => {
    expect(messageDirection(`${SHALOM} hello`, "<p>hello</p>", "ltr")).toBe("rtl")
    expect(messageDirection(null, `<div dir="rtl"><p>${SHALOM}</p></div>`, "ltr")).toBe("rtl")
    expect(messageDirection("12:30", "<p>12:30</p>", "rtl")).toBe("rtl")
    expect(messageDirection(null, null, "ltr")).toBe("ltr")
  })
})
