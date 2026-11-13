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

describe("links in a served body", () => {
  it("open https, http, and mailto links in a new tab cut off from Maane, and drop every other link's address", () => {
    const stored = sanitizeMailHtml(
      '<p><a href="https://www.example.com/a" target="_self" rel="opener">a</a>' +
        '<a href="http://www.example.com/b">b</a><a href="mailto:dana@example.com">c</a>' +
        '<a href="tel:+15555550100">d</a><a href="cid:part@example.com">e</a><a href="/relative">f</a>' +
        '<a href="javascript:alert(1)">g</a><a name="top">h</a></p>',
    )
    const { html } = renderMailHtml(stored, { remoteImages: false, inline: none })
    const opens = (href: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">`
    expect(html).toBe(
      `<p>${opens("https://www.example.com/a")}a</a>${opens("http://www.example.com/b")}b</a>` +
        `${opens("mailto:dana@example.com")}c</a><a>d</a><a>e</a><a>f</a><a>g</a><a name="top">h</a></p>`,
    )
  })
})

describe("body documents", () => {
  it("frames directed HTML in the message's direction, with no CSS that guesses directions", () => {
    const document = htmlDocument(`<p dir="rtl">${SHALOM} hello</p>`, "rtl")
    expect(document).toContain('<html dir="rtl">')
    expect(document).toContain('<body dir="rtl">')
    expect(htmlDocument("<p>hello</p>", "ltr")).toContain('<body dir="ltr">')
    expect(document).not.toContain("unicode-bidi")
    expect(document).not.toContain("text-align")
  })

  it("writes text escaped, line by line, each line with its own direction", () => {
    const document = textDocument(`${SHALOM}\r\nhello <b>&</b>\n\n2026-11-12`)
    expect(document).toContain('<body dir="rtl">')
    expect(document).toContain(`<div dir="rtl">${SHALOM}</div>`)
    expect(document).toContain('<div dir="ltr">hello &lt;b&gt;&amp;&lt;/b&gt;</div>')
    // A line without a letter takes the document's direction.
    expect(document).toContain('<div dir="rtl"></div><div dir="rtl">2026-11-12</div>')
    expect(document).not.toContain("<b>")
  })
})
