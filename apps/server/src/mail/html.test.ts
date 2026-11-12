import { describe, expect, it } from "vitest"
import { htmlDocument, textDocument } from "./body.ts"
import { renderMailHtml, sanitizeMailHtml } from "./html.ts"

// Hebrew from code points: the repository holds no literal Hebrew outside he.json.
const SHALOM = String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd)
const DATA_PNG = "data:image/png;base64,iVBORw0KGgo="

const none = () => null

describe("renderMailHtml", () => {
  it("embeds a cid: image of the message's clean parts, and removes an unknown one with its tag", () => {
    const stored = sanitizeMailHtml('<p>a<img src="cid:logo@example.com" alt="logo">b<img src="cid:other" alt="x"></p>')
    const { html } = renderMailHtml(stored, {
      remoteImages: false,
      inline: (id) => (id === "logo@example.com" ? DATA_PNG : null),
    })
    expect(html).toBe(`<p>a<img alt="logo" src="${DATA_PNG}" />b</p>`)
  })

  it("reads a percent-encoded cid: URL and one written with angle brackets", () => {
    const seen: string[] = []
    renderMailHtml('<img src="cid:a%40b.example"><img src="cid:%3Cc@d%3E">', {
      remoteImages: false,
      inline: (id) => {
        seen.push(id)
        return null
      },
    })
    expect(seen).toEqual(["a@b.example", "c@d"])
  })

  it("removes remote images until they are allowed, and counts them", () => {
    const stored = sanitizeMailHtml(
      '<p>x<img src="https://img.example.com/a.png"><img src="http://img.example.com/b.png"></p>',
    )
    const blocked = renderMailHtml(stored, { remoteImages: false, inline: none })
    expect(blocked.remoteImages).toBe(1)
    expect(blocked.html).toBe("<p>x</p>")
    expect(blocked.html).not.toContain("example.com")
    const shown = renderMailHtml(stored, { remoteImages: true, inline: none })
    // Only https: the frame's policy allows no plain http image.
    expect(shown.html).toBe('<p>x<img src="https://img.example.com/a.png" /></p>')
  })

  it("never keeps a data: URL that did not come from a part, whatever the stored HTML holds", () => {
    const { html } = renderMailHtml(
      `<img src="${DATA_PNG}"><img src="javascript:alert(1)"><a href="${DATA_PNG}">x</a>`,
      {
        remoteImages: true,
        inline: none,
      },
    )
    expect(html).toBe("<a>x</a>")
  })

  it("keeps the allow list: no script, no event handler, no style that loads anything", () => {
    const { html } = renderMailHtml(
      '<p onclick="x()" style="color: red; background-image: url(https://t.example.com/p)">a</p><script>x()</script><iframe src="https://example.com"></iframe>',
      { remoteImages: true, inline: none },
    )
    expect(html).toBe('<p style="color:red">a</p>')
  })
})

describe("body documents", () => {
  it("makes Hebrew HTML without dir right to left, from the message's first strong character", () => {
    const document = htmlDocument(`<p>${SHALOM} hello</p>`, null)
    expect(document).toContain('<body dir="rtl">')
    expect(htmlDocument("<p>hello</p>", `${SHALOM}`)).toContain('<body dir="rtl">')
    expect(htmlDocument("<p>hello</p>", null)).toContain('<body dir="ltr">')
    // Each block without the sender's direction takes its own: an English paragraph inside a Hebrew message.
    expect(document).toContain(":not([dir]):not(body [dir] *){unicode-bidi:plaintext;text-align:start}")
    expect(textDocument("hello")).not.toContain("unicode-bidi:plaintext")
  })

  it("writes text escaped, line by line, each line with its own direction", () => {
    const document = textDocument(`${SHALOM}\r\nhello <b>&</b>\n\n2026-11-12`)
    expect(document).toContain('<body dir="rtl">')
    expect(document).toContain(`<div dir="rtl">${SHALOM}</div>`)
    expect(document).toContain('<div dir="ltr">hello &lt;b&gt;&amp;&lt;/b&gt;</div>')
    expect(document).toContain("<div></div><div>2026-11-12</div>")
    expect(document).not.toContain("<b>")
  })
})
