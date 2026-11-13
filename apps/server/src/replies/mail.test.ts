import { MESSAGES } from "@maane/shared"
import { simpleParser } from "mailparser"
import { describe, expect, it } from "vitest"
import { withoutComments } from "../testing/comments.ts"
import { png } from "../testing/files.ts"
import { COLUMN_WIDTH, IMAGE_MAX_WIDTH, imagesToRead, prepareImage } from "./images.ts"
import { type Entry, type EntryImage, israelTime, LRI, layout, PDI } from "./layout.ts"
import { BUDGET, buildReply, MessageTooLarge, type ReplyMail, ReplyTooLong, storedBody } from "./mail.ts"

// Structural tests of the customer's email (plan 3.2). Hebrew from code points: the repository holds no literal
// Hebrew outside he.json.
const cp = (...points: number[]) => String.fromCodePoint(...points)
const SHALOM = cp(0x5e9, 0x5dc, 0x5d5, 0x5dd)
const TODA = cp(0x5ea, 0x5d5, 0x5d3, 0x5d4)
const DANA = `${cp(0x5d3, 0x5e0, 0x5d4)} ${cp(0x5db, 0x5d4, 0x5df)}`
const CODE = "K7QF-2M9X"

function entry(values: Partial<Entry> = {}): Entry {
  return {
    name: "Dana Cohen",
    initialsOf: "Dana Cohen",
    at: new Date("2026-11-12T08:15:00Z"),
    html: null,
    text: "A question.",
    images: new Map(),
    files: [],
    ...values,
  }
}

function mail(values: Partial<ReplyMail> = {}, locale: "he" | "en" = "he"): ReplyMail {
  const body = storedBody(`<p dir="auto">${SHALOM}, ${TODA}</p><p dir="auto">An English paragraph.</p>`, "", "")
  return {
    from: { address: "support@example.com", name: "Agent Smith (Example Support)" },
    to: [{ address: "dana@example.com", name: "Dana Cohen" }],
    cc: [],
    subject: "Re: A question [#7]",
    messageId: "reply-1@example.com",
    inReplyTo: "in-1@mail.example.com",
    references: ["in-1@mail.example.com"],
    date: new Date("2026-11-13T12:05:00Z"),
    words: MESSAGES[locale].mail,
    lang: locale,
    referenceCode: CODE,
    authorName: "Agent Smith",
    html: body.html,
    text: `${SHALOM}, ${TODA}\n\nAn English paragraph.`,
    fallbackDirection: locale === "he" ? "rtl" : "ltr",
    attachments: [],
    history: [],
    ...values,
  }
}

// skipImageLinks: the HTML as sent, its cid: links not turned into data: URLs.
const parse = async (mime: Buffer) => simpleParser(mime, { skipImageLinks: true })

/** The tags of the HTML with the given name, as written. */
const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? []

describe("the customer's email", () => {
  it("puts the header line and the reference code first, the code isolated left to right, in both parts", async () => {
    const parsed = await parse(await buildReply(mail({ history: [entry()] })))
    const words = MESSAGES.he.mail
    const html = parsed.html || ""
    const reference = `${words.reference}: <span dir="ltr">${CODE}</span>`
    expect(html.indexOf(words.header)).toBeGreaterThan(-1)
    expect(html.indexOf(words.header)).toBeLessThan(html.indexOf(reference))
    // Before any conversation block.
    expect(html.indexOf(reference)).toBeLessThan(html.indexOf('class="email-avatar"'))
    const text = (parsed.text ?? "").split("\n")
    expect(text[0]).toBe(words.header)
    expect(text[1]).toBe(`${words.reference}: ${LRI}${CODE}${PDI}`)
  })

  it("sets dir on the html, the body, every table, and each paragraph; never dir=auto", async () => {
    const history = [
      entry({
        html: `<p dir="auto">${SHALOM}</p><div>An English line</div><p><img src="cid:x"></p><p dir="auto" style="direction:rtl">styled</p><P DIR="AUTO">upper</P>`,
        text: null,
      }),
    ]
    const html = (await parse(await buildReply(mail({ history })))).html || ""
    expect(html).toMatch(/^<!doctype html><html dir="rtl" lang="he">/)
    expect(tags(html, "body")[0]).toContain('dir="rtl"')
    const tables = tags(html, "table")
    expect(tables.length).toBeGreaterThanOrEqual(5)
    for (const table of tables) expect(table).toMatch(/ dir="(rtl|ltr)"/)
    expect(html).not.toMatch(/dir="auto"/i)
    // The reply's paragraphs by their first strong character, the history's too.
    expect(html).toContain(`<p dir="rtl">${SHALOM}, ${TODA}</p>`)
    expect(html).toContain('<p dir="ltr">An English paragraph.</p>')
    expect(html).toContain('<div dir="ltr">An English line</div>')
  })

  it("is left to right in English, with the English words", async () => {
    const english = mail(
      { html: '<p dir="auto">Thanks, it is fixed.</p>', text: "Thanks, it is fixed.", history: [entry()] },
      "en",
    )
    const parsed = await parse(await buildReply(english))
    const html = parsed.html || ""
    expect(html).toMatch(/<html dir="ltr" lang="en">/)
    expect(html).toContain(MESSAGES.en.mail.header)
    expect(html).toContain('<p dir="ltr">Thanks, it is fixed.</p>')
    expect(html).toContain('On <span dir="ltr">12/11/2026 10:15</span>, <span dir="ltr">Dana Cohen</span> wrote:')
    for (const table of tags(html, "table")) expect(table).toContain('dir="ltr"')
  })

  it("keeps an English customer message left to right inside a Hebrew email, and a Hebrew name right to left", async () => {
    const history = [entry({ name: DANA, initialsOf: DANA, html: "<p>The order did not arrive.</p>", text: null })]
    const html = (await parse(await buildReply(mail({ history })))).html || ""
    expect(html).toMatch(/<html dir="rtl"/)
    expect(html).toContain('<p dir="ltr">The order did not arrive.</p>')
    expect(html).toContain(`<span dir="rtl">${DANA}</span>`)
    // The initials of a Hebrew name, in a table cell, not an image.
    expect(html).toMatch(
      new RegExp(`<td class="email-avatar" dir="rtl"[^>]*bgcolor="#EEEEEE"[^>]*>${cp(0x5d3)}${cp(0x5db)}</td>`),
    )
  })

  it("quotes the public history newest first in a blockquote of type cite, after an attribution line", async () => {
    const history = [
      entry({
        name: "Agent Smith (Example Support)",
        initialsOf: "Agent Smith",
        text: "Second.",
        at: new Date("2026-11-12T10:00:00Z"),
      }),
      entry({ text: "First.", at: new Date("2026-11-11T09:00:00Z") }),
    ]
    const parsed = await parse(await buildReply(mail({ history })))
    const html = parsed.html || ""
    const quote = html.indexOf('<blockquote type="cite"')
    expect(quote).toBeGreaterThan(html.indexOf(MESSAGES.he.mail.reference))
    expect(html.indexOf("Second.")).toBeGreaterThan(quote)
    expect(html.indexOf("Second.")).toBeLessThan(html.indexOf("First."))
    // The attribution names the newest message of the history, in Israel time.
    const attribution = MESSAGES.he.mail.attribution
      .replace("{date}", '<span dir="ltr">12/11/2026 12:00</span>')
      .replace("{name}", '<span dir="ltr">Agent Smith (Example Support)</span>')
    expect(html.indexOf(attribution)).toBeLessThan(quote)
    expect(html).toContain(">AS</td>")
    const text = parsed.text ?? ""
    expect(text).toContain(
      "> Agent Smith (Example Support) | 12/11/2026 12:00\n> Second.\n>\n> Dana Cohen | 11/11/2026 11:00",
    )
  })

  it("writes times in Israel time, daylight saving included", () => {
    expect(israelTime(new Date("2026-07-21T21:18:00Z"))).toBe("22/07/2026 00:18")
    expect(israelTime(new Date("2026-11-13T12:05:00Z"))).toBe("13/11/2026 14:05")
  })

  it("names the files of earlier messages without links, and gives the links in a message their underline", async () => {
    const history = [
      entry({
        html: '<p>See <a href="https://www.example.com/x">this</a></p>',
        files: [
          { name: "invoice.pdf", href: null },
          { name: "photo.jpg", href: null },
        ],
      }),
    ]
    const html = (await parse(await buildReply(mail({ history }, "en")))).html || ""
    expect(html).toContain('Files: <span dir="ltr">invoice.pdf</span>, <span dir="ltr">photo.jpg</span>')
    expect(html).toContain('<a href="https://www.example.com/x" style="text-decoration:underline !important">this</a>')
    expect(html).toContain(".email-bg a{color:inherit !important;text-decoration:none !important}")
  })

  it("uses neutral greys only, with a dark-mode block and rules under Outlook's mark", () => {
    const { html } = layout(
      {
        dir: "ltr",
        lang: "en",
        words: MESSAGES.en.mail,
        referenceCode: CODE,
        current: entry(),
        history: [entry()],
      },
      { level: 0, imageNames: false },
    )
    const colours = [...html.matchAll(/#([0-9A-Fa-f]{6})\b/g)].map((m) => (m[1] ?? "").toUpperCase())
    expect(colours.length).toBeGreaterThan(0)
    for (const colour of colours) expect(colour.slice(0, 2).repeat(3)).toBe(colour)
    expect(html).toContain("@media (prefers-color-scheme:dark)")
    expect(html).toContain("[data-ogsb] .email-bg{background-color:#FFFFFF !important}")
    // A message's own colours give way in dark mode, and its tables stay inside the column.
    expect(html).toContain(
      ".email-content *{color:inherit !important;background-color:transparent !important;border-color:#333333 !important}",
    )
    expect(html).toContain(".email-content table{width:auto !important;max-width:100% !important}")
    expect(html).toMatch(/<td colspan="2" dir="ltr" class="email-text email-content"/)
  })
})

describe("images", () => {
  it("downscales an image wider than twice the column, and keeps a smaller one as it is", async () => {
    const large = await prepareImage(png(3000, 1000), "image/png")
    expect(large).toMatchObject({ contentType: "image/png", width: IMAGE_MAX_WIDTH, height: 400 })
    const small = png(300, 200)
    expect(await prepareImage(small, "image/png")).toEqual({
      content: small,
      contentType: "image/png",
      width: 300,
      height: 200,
    })
    expect(await prepareImage(Buffer.from("not an image"), "image/png")).toBeNull()
    expect(await prepareImage(small, "image/svg+xml")).toBeNull()
  })

  it("embeds a history image as CID, sized as attribute and style no wider than the column", async () => {
    const prepared = await prepareImage(png(3000, 1000), "image/png")
    if (!prepared) throw new Error("not prepared")
    const image: EntryImage = { ...prepared, cid: "img-1@example.com", fileName: "screen.png" }
    const history = [
      entry({
        html: `<p>${SHALOM}</p><p><img src="cid:shot@mail.example.com" alt="shot"><img src="https://img.example.com/x.png"></p>`,
        text: null,
        images: new Map([["shot@mail.example.com", image]]),
      }),
    ]
    const parsed = await parse(await buildReply(mail({ history })))
    const html = parsed.html || ""
    const width = COLUMN_WIDTH - 14
    const height = Math.round((400 * width) / IMAGE_MAX_WIDTH)
    expect(html).toContain(
      `<img alt="shot" src="cid:img-1@example.com" width="${width}" height="${height}" ` +
        `style="width:${width}px;max-width:100%;height:auto;border:0" />`,
    )
    // A remote image never goes into the email; an image alone keeps the Hebrew message's direction.
    expect(html).not.toContain("img.example.com")
    expect(html).toMatch(/<p dir="rtl"><img alt="shot"/)
    const embedded = parsed.attachments.find((file) => file.cid === "img-1@example.com")
    expect(embedded).toMatchObject({
      contentType: "image/png",
      contentDisposition: "inline",
      size: prepared.content.length,
    })
  })
})

describe("the size budget", () => {
  it("refuses a reply that alone, with no history left, is over Gmail's budget", async () => {
    const long = `<p>${"A long reply, written at length. ".repeat(80)}</p>`
    const history = [entry({ text: "Earlier." })]
    await expect(buildReply(mail({ html: long, history }), { ...BUDGET, html: 2_000 })).rejects.toBeInstanceOf(
      ReplyTooLong,
    )
    // The same reply within the budget is built, its history left out first if it must be.
    expect(await buildReply(mail({ html: long, history }), { ...BUDGET, html: 20_000 })).toBeInstanceOf(Buffer)
  })

  it("gives a long string in a message Word's own copy, cut into lines", async () => {
    const token = "X".repeat(200)
    const html = (await parse(await buildReply(mail({ history: [entry({ html: `<p>${token}</p>`, text: null })] }))))
      .html
    expect(html).toContain(`<!--[if mso]>${"X".repeat(50)}<br>`)
    expect(html).toContain(`<!--[if !mso]><!-->${token}<!--<![endif]-->`)
  })

  it("gives a history message in short form that starts with a long string Word's own copy too", () => {
    const token = "Y".repeat(200)
    const history = [entry({ html: `<p>${token} and then ${"more words of the message ".repeat(20)}</p>`, text: null })]
    const conversation = { dir: "ltr" as const, lang: "en", words: MESSAGES.en.mail, referenceCode: CODE }
    // Level 1: the oldest (and only) history message in short form.
    const { html } = layout({ ...conversation, current: entry(), history }, { level: 1, imageNames: false })
    expect(html).toContain(`<!--[if mso]>${"Y".repeat(50)}<br>`)
    // What every other client shows: the short text once, unchanged, in its own block.
    const visible = withoutComments(html)
    expect(visible, html).toMatch(/<div dir="ltr">Y{200} and then [^<]*\.\.\.<\/div>/)
    expect(visible.split(token).length).toBe(2)
  })

  it("decides from stored sizes which history images are read, newest first, before reading any", () => {
    const mb = 1024 * 1024
    const plan = imagesToRead(
      [
        { message: 0, size: 4 * mb },
        { message: 0, size: 4 * mb },
        { message: 1, size: 6 * mb },
        { message: 2, size: 3 * mb },
        { message: 3, size: 1 * mb },
      ],
      10 * mb,
    )
    // Over one image's limit, then over the budget: shown by name, never read; a smaller one still fits.
    expect(plan).toEqual([true, true, false, false, true])
  })

  const long = (n: number) =>
    entry({
      text: null,
      html: `<p>Message ${n}. ${"Some words of an earlier message, written at length. ".repeat(60)}</p>`,
      at: new Date(Date.UTC(2026, 10, 1, n)),
    })

  it("keeps the HTML under Gmail's budget by shortening the oldest history first, the code still at the top", async () => {
    const history = Array.from({ length: 30 }, (_, n) => long(29 - n))
    const parsed = await parse(await buildReply(mail({ history }), { ...BUDGET, html: 60_000 }))
    const html = parsed.html || ""
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(60_000)
    expect(html.indexOf(CODE)).toBeLessThan(2_000)
    // The newest in full, the oldest in short form.
    expect(html).toContain(`Message 29. ${"Some words of an earlier message, written at length. ".repeat(10)}`)
    expect(html).not.toContain(`Message 0. ${"Some words of an earlier message, written at length. ".repeat(10)}`)
    expect(html).toMatch(/Message 0\. Some words[^<]*\.\.\.<\/div>/)
    expect(html).not.toContain(MESSAGES.he.mail.olderOmitted.split("{")[0] ?? "-")
  })

  it("leaves the oldest out, and says how many, when even short forms do not fit", async () => {
    const history = Array.from({ length: 30 }, (_, n) => long(29 - n))
    const html = (await parse(await buildReply(mail({ history }), { ...BUDGET, html: 12_000 }))).html || ""
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(12_000)
    expect(html).toMatch(new RegExp(MESSAGES.he.mail.olderOmitted.replace("{count}", "\\d+")))
    expect(html).toContain("Message 29.")
  })

  it("shows history images by their names when the message would be too large, then refuses the reply's own files", async () => {
    const big = png(1200, 1200, [10, 200, 30])
    const prepared = await prepareImage(big, "image/png")
    if (!prepared) throw new Error("not prepared")
    const noisy = { ...prepared, content: Buffer.alloc(300_000, 7), cid: "img-2@example.com", fileName: "scan.png" }
    const history = [entry({ html: '<p><img src="cid:a@x"></p>', text: null, images: new Map([["a@x", noisy]]) })]
    const limit = { ...BUDGET, message: 200_000 }
    const parsed = await parse(await buildReply(mail({ history }), limit))
    expect(parsed.html).toContain("<span>[scan.png]</span>")
    expect(parsed.html).not.toContain("cid:")
    expect(parsed.attachments).toHaveLength(0)

    const attachments = [
      { fileName: "big.bin", contentType: "application/octet-stream", content: Buffer.alloc(250_000) },
    ]
    await expect(buildReply(mail({ history, attachments }), limit)).rejects.toBeInstanceOf(MessageTooLarge)
  })
})

describe("links in the customer's email (plan 3.4)", () => {
  const tracked = (url: string) => `https://links.example.com/l/${encodeURIComponent(url).length}`

  it("gives the agent's http and https links their tracked address in the HTML part only, keeping their look", async () => {
    const html = `<p>Read <a href="https://www.example.com/guide?a=1&amp;b=2">the guide</a> or <a href="http://example.com/x">this</a>.</p><p><a href="mailto:help@example.com">mail us</a> <a href="tel:+15550100">call</a></p><blockquote><p><a href="https://example.com/quoted">quoted by the agent</a></p></blockquote>`
    const seen: string[] = []
    const link = (href: string) => {
      seen.push(href)
      return tracked(href)
    }
    const text = "Read the guide [https://www.example.com/guide?a=1&b=2] or this [http://example.com/x]."
    const history = [entry({ html: '<p>Earlier: <a href="https://example.com/history">a link</a></p>' })]
    const parsed = await parse(await buildReply(mail({ html, text, link, history }, "en")))
    const out = parsed.html || ""
    // The agent's own links, a blockquote it wrote included; never mailto or tel; never the quoted history.
    expect(seen.sort()).toEqual(
      ["https://www.example.com/guide?a=1&b=2", "http://example.com/x", "https://example.com/quoted"].sort(),
    )
    expect(out).toContain(
      `<a href="${tracked("https://www.example.com/guide?a=1&b=2")}" style="text-decoration:underline !important">the guide</a>`,
    )
    expect(out).toContain('<a href="mailto:help@example.com" style="text-decoration:underline !important">mail us</a>')
    expect(out).not.toContain("https://www.example.com/guide")
    expect(out).toContain(
      '<a href="https://example.com/history" style="text-decoration:underline !important">a link</a>',
    )
    // The text part keeps the links as written.
    expect(parsed.text).toContain(text)
    expect(parsed.text).not.toContain("links.example.com")
  })

  it("leaves the text part as it was without links, and the HTML links as written when nothing tracks them", async () => {
    const html = '<p><a href="https://example.com/a">a</a></p>'
    const text = "a [https://example.com/a]"
    const plain = await parse(await buildReply(mail({ html, text }, "en")))
    const withLinks = await parse(await buildReply(mail({ html, text, link: tracked }, "en")))
    expect(withLinks.text).toBe(plain.text)
    expect(plain.html).toContain('href="https://example.com/a"')
  })

  it("names history files with their download links in the HTML part, and by name only in the text part", async () => {
    const history = [
      entry({
        text: "With files.",
        files: [
          { name: "invoice.pdf", href: "https://links.example.com/f/AAAAAAAAAAAAAAAAAAAAAA" },
          { name: "notes.txt", href: null },
        ],
      }),
    ]
    const parsed = await parse(await buildReply(mail({ history }, "en")))
    expect(parsed.html).toContain(
      'Files: <a href="https://links.example.com/f/AAAAAAAAAAAAAAAAAAAAAA" style="text-decoration:underline !important"><span dir="ltr">invoice.pdf</span></a>, <span dir="ltr">notes.txt</span>',
    )
    expect(parsed.text).toContain("> Files: invoice.pdf, notes.txt")
    expect(parsed.text).not.toContain("links.example.com")
  })
})
