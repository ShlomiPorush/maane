import { REFERENCE_ALPHABET, REFERENCE_CODE } from "@maane/shared"
import { describe, expect, it } from "vitest"
import {
  base64Lines,
  encodedWord,
  fromCodePoints,
  INVOICE,
  mime,
  quotedPrintable,
  SHALOM,
  SHALOM_OLAM,
  windows1255,
} from "../testing/mime.ts"
import { classify } from "./classify.ts"
import { contentOf, headerBlock, storedContentType } from "./content.ts"
import { describeGraphError, isExpiredDelta } from "./graph.ts"
import { MAX_REFERENCES, MESSAGE_ID_MAX, messageIds, parseMessage } from "./parse.ts"
import { sanitizeMailHtml, textFromHtml } from "./sanitize.ts"
import { wellFormed, wellFormedText } from "./text.ts"
import { newReferenceCode, referenceCodesIn, referencedIds, ticketNumbersIn } from "./threading.ts"

const lines = (...headers: string[]) =>
  headers.map((line) => ({ key: line.slice(0, line.indexOf(":")).toLowerCase(), line }))
const plain = { value: "text/plain", reportType: null }

describe("classification (RFC 3834, RFC 3464)", () => {
  it("treats each sign of automated mail as automated", () => {
    const cases: [string[], { value: string; reportType: string | null }, string][] = [
      [["Auto-Submitted: auto-replied"], plain, "auto_submitted"],
      [["Auto-Submitted: auto-generated; owner-email=x@example.com"], plain, "auto_submitted"],
      [[], { value: "multipart/report", reportType: "delivery-status" }, "delivery_report"],
      [[], { value: "multipart/report", reportType: "disposition-notification" }, "disposition_report"],
      [["Precedence: bulk"], plain, "precedence"],
      [["Precedence: List"], plain, "precedence"],
      [["Precedence: junk"], plain, "precedence"],
      [["List-Id: <news.example.com>"], plain, "list"],
      [["List-Unsubscribe: <mailto:leave@example.com>"], plain, "list"],
      [["X-Autoreply: yes"], plain, "autoreply_header"],
      [["X-Autorespond: yes"], plain, "autoreply_header"],
    ]
    for (const [headers, contentType, sign] of cases) {
      const result = classify({ headers: lines(...headers), contentType, from: "dana@example.com" })
      expect(result, headers.join()).toMatchObject({ automated: true, possiblyAutomated: false })
      expect(result.signs).toContain(sign)
    }
  })

  it("is not fooled by Auto-Submitted: no, by X-Auto-Response-Suppress, or by an ordinary precedence", () => {
    for (const headers of [
      ["Auto-Submitted: no"],
      ["Auto-Submitted: No ; comment"],
      ["X-Auto-Response-Suppress: All"],
      ["X-Auto-Response-Suppress: DR, RN, NRN, OOF, AutoReply"],
      ["Precedence: first-class"],
    ])
      expect(classify({ headers: lines(...headers), contentType: plain, from: "dana@example.com" })).toEqual({
        automated: false,
        signs: [],
        possiblyAutomated: false,
      })
    // A report of another kind is not a delivery or disposition report.
    expect(
      classify({ headers: [], contentType: { value: "multipart/report", reportType: "x" }, from: null }).automated,
    ).toBe(false)
  })

  it("flags MAILER-DAEMON and postmaster without a sign as possibly automated, and with a sign as automated", () => {
    for (const from of ["MAILER-DAEMON@example.com", "mailer-daemon@mx.example.com", "postmaster@example.com"]) {
      expect(classify({ headers: [], contentType: plain, from: from.toLowerCase() })).toEqual({
        automated: false,
        signs: [],
        possiblyAutomated: true,
      })
    }
    expect(
      classify({ headers: lines("Auto-Submitted: auto-replied"), contentType: plain, from: "postmaster@example.com" }),
    ).toMatchObject({ automated: true, possiblyAutomated: false })
  })

  it("classifies by mailparser's parsed content type, also with a comment after the report type", async () => {
    for (const type of ["delivery-status (returned mail)", '"Delivery-Status"', "delivery-status; charset=x"]) {
      const parsed = await parseMessage(
        Buffer.from(
          `From: MAILER-DAEMON@example.com\r\nContent-Type: multipart/REPORT; report-type=${type}; boundary=B\r\n\r\n` +
            "--B\r\nContent-Type: text/plain\r\n\r\nfailed\r\n--B--\r\n",
          "latin1",
        ),
      )
      const contentType = storedContentType(parsed.contentType)
      expect(contentType, type).toEqual({ value: "multipart/report", reportType: "delivery-status" })
      expect(classify({ headers: [], contentType, from: "mailer-daemon@example.com" }).signs).toEqual([
        "delivery_report",
      ])
    }
    // A media type that is not a plain token pair is stored as octet-stream.
    expect(storedContentType({ value: "text/<b>", params: {} }).value).toBe("application/octet-stream")
  })
})

describe("threading hints and the reference code", () => {
  it("makes codes of XXXX-XXXX over an alphabet without look-alike characters", () => {
    for (const lookAlike of ["0", "O", "1", "I", "L"]) expect(REFERENCE_ALPHABET).not.toContain(lookAlike)
    const codes = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const code = newReferenceCode()
      expect(code).toMatch(REFERENCE_CODE)
      codes.add(code)
    }
    expect(codes.size).toBe(2000)
    // Every symbol of the alphabet shows up, and nothing else.
    const seen = new Set([...codes].join("").replaceAll("-", ""))
    expect([...seen].sort().join("")).toBe([...REFERENCE_ALPHABET].sort().join(""))
  })

  it("finds codes that stand alone in a body and numbers written as [#n] in a subject", () => {
    expect(referenceCodesIn("Ref: K7QX-92MF\n> Ref: K7QX-92MF and AB2C-DEFG")).toEqual(["K7QX-92MF", "AB2C-DEFG"])
    // Inside a longer word, in lower case, or with a look-alike character: not a code.
    expect(referenceCodesIn("XK7QX-92MF K7QX-92MFA k7qx-92mf K7QX-920F")).toEqual([])
    expect(referenceCodesIn(`${SHALOM} K7QX-92MF ${SHALOM}`)).toEqual(["K7QX-92MF"])
    expect(ticketNumbersIn("Re: [#1234] help [#77] [#1234]")).toEqual([1234, 77])
    expect(ticketNumbersIn("[#0] #12 [12] [#x]")).toEqual([])
  })

  it("tries In-Reply-To first, then References from the parent back to the root, at most 50", () => {
    expect(referencedIds(["c@x"], ["a@x", "b@x", "c@x"])).toEqual(["c@x", "b@x", "a@x"])
    const many = referencedIds(
      Array.from({ length: 70 }, (_, i) => `i${i}@x`),
      Array.from({ length: 70 }, (_, i) => `r${i}@x`),
    )
    expect(many).toHaveLength(50)
    expect(many[0]).toBe("i0@x")
    expect(messageIds("<a@x> <b@x>\r\n <c@x>")).toEqual(["a@x", "b@x", "c@x"])
    expect(messageIds(["<a@x>", "<a@x>"])).toEqual(["a@x"])
    expect(messageIds("bare@x")).toEqual(["bare@x"])
    expect(messageIds(undefined)).toEqual([])
  })
})

describe("values PostgreSQL cannot store", () => {
  it("replaces U+0000 and unpaired surrogates with U+FFFD and says so", () => {
    const replacement = fromCodePoints(0xfffd)
    expect(wellFormedText(`a${String.fromCharCode(0)}b`)).toEqual({ value: `a${replacement}b`, changed: true })
    expect(wellFormedText(`x${String.fromCharCode(0xd800)}`)).toEqual({ value: `x${replacement}`, changed: true })
    expect(wellFormedText(SHALOM_OLAM)).toEqual({ value: SHALOM_OLAM, changed: false })
    const nested = wellFormed({ list: [{ [`k${String.fromCharCode(0)}`]: String.fromCharCode(0xdc00) }], when: null })
    expect(nested.changed).toBe(true)
    expect(nested.value).toEqual({ list: [{ [`k${replacement}`]: replacement }], when: null })
    const bytes = Buffer.from([0, 1])
    expect(wellFormed({ bytes }).value.bytes).toBe(bytes)
  })
})

describe("sanitized HTML", () => {
  it("drops data: URLs and every scheme but https, http, mailto, tel, and cid", () => {
    const html = sanitizeMailHtml(
      [
        '<p dir="rtl" style="color: #333; background: url(data:image/png;base64,QUJD)">x</p>',
        '<img src="data:image/png;base64,QUJD"><img src="cid:part1"><img src="https://example.com/a.png">',
        '<a href="javascript:alert(1)">j</a><a href="vbscript:x">v</a><a href="data:text/html,hi">d</a>',
        '<a href="mailto:dana@example.com">m</a><a href="tel:+1-555-0100">t</a><a href="//example.com/x">p</a>',
        '<a href="http://example.com/">h</a><script>bad()</script><style>p{}</style><iframe src="https://example.com"></iframe>',
        '<p style="width: expression(alert(1)); color: rgb(1, 2, 3)" onclick="x()">s</p>',
        '<img srcset="data:image/png;base64,QUJD 1x"><table background="data:x"><tr><td>c</td></tr></table>',
      ].join(""),
    )
    expect(html).not.toMatch(
      /data:|javascript:|vbscript:|expression|url\(|script|<style|iframe|onclick|srcset|background=/i,
    )
    expect(html).toContain('src="cid:part1"')
    expect(html).toContain('src="https://example.com/a.png"')
    expect(html).toContain('href="mailto:dana@example.com"')
    expect(html).toContain('href="tel:+1-555-0100"')
    expect(html).toContain('href="http://example.com/"')
    expect(html).not.toContain('href="//example.com/x"')
    expect(html).toContain('dir="rtl"')
    expect(html).toContain("color:rgb(1, 2, 3)")
  })

  it("makes text from sanitized HTML without images", () => {
    expect(textFromHtml(sanitizeMailHtml(`<p>${SHALOM}</p><img src="cid:a" alt="logo"><p>two</p>`))).toBe(
      `${SHALOM}\n\ntwo`,
    )
  })
})

describe("parsing", () => {
  it("decodes Hebrew in UTF-8 with base64 and quoted-printable, and in Windows-1255", async () => {
    for (const encoding of ["base64", "quoted-printable", "8bit"] as const) {
      const parsed = await parseMessage(mime({ text: { content: SHALOM_OLAM, encoding } }))
      expect(parsed.text?.trim(), encoding).toBe(SHALOM_OLAM)
    }
    for (const encoding of ["quoted-printable", "8bit", "base64"] as const) {
      const parsed = await parseMessage(mime({ text: { content: SHALOM_OLAM, charset: "windows-1255", encoding } }))
      expect(parsed.text?.trim(), encoding).toBe(SHALOM_OLAM)
    }
    // The fixtures are what they claim: QP of UTF-8 Hebrew is all escapes, Windows-1255 one byte a letter.
    expect(quotedPrintable(Buffer.from(SHALOM, "utf8"))).toBe("=D7=A9=D7=9C=D7=95=D7=9D")
    expect([...windows1255(SHALOM)]).toEqual([0xf9, 0xec, 0xe5, 0xed])
    expect(base64Lines(Buffer.from("x"))).toBe("eA==")
  })

  it("decodes an encoded-word subject, Hebrew file names, and mixed Hebrew and English", async () => {
    const mixed = `${SHALOM} Dana, order 1234 ${INVOICE}`
    const parsed = await parseMessage(
      mime({
        subject: `${encodedWord(`${SHALOM} order`)} ${encodedWord("1234", "Q")}`,
        text: { content: mixed, encoding: "quoted-printable" },
        html: { content: `<p dir="rtl">${mixed}</p>` },
        attachments: [
          { fileName: `${INVOICE}.pdf`, contentType: "application/pdf", content: Buffer.from("%PDF-1.4\n") },
          { fileName: `${SHALOM} notes.txt`, contentType: "text/plain", content: Buffer.from("notes\n") },
        ],
      }),
    )
    // RFC 2047 6.2: the white space between two adjacent encoded words is not part of the text.
    expect(parsed.subject).toBe(`${SHALOM} order1234`)
    expect(parsed.text?.trim()).toBe(mixed)
    expect(parsed.html).toBe(`<p dir="rtl">${mixed}</p>`)
    expect(parsed.parts.map((part) => [part.fileName, part.kind, part.declaredType])).toEqual([
      [`${INVOICE}.pdf`, "attachment", "application/pdf"],
      [`${SHALOM} notes.txt`, "attachment", "text/plain"],
    ])
  })

  it("keeps a plain-text-only message as it is, and makes text from HTML when there is no text part", async () => {
    const only = await parseMessage(mime({ text: { content: `${SHALOM}\nline two` } }))
    expect(only).toMatchObject({ text: `${SHALOM}\nline two`, html: null })
    const htmlOnly = await parseMessage(mime({ html: { content: `<p>${SHALOM}</p><img src="cid:x">` } }))
    expect(htmlOnly.text).toBe(SHALOM)
  })

  it("reads the addresses, the IDs, and a report's original Message-ID", async () => {
    const parsed = await parseMessage(
      mime({
        messageId: "m1@example.com",
        from: '"Dana" <DANA@Example.com>',
        to: "Support <support@example.com>, other@example.com",
        cc: "Team: one@example.com, two@example.com;",
        inReplyTo: "p@example.com",
        references: ["r@example.com", "p@example.com"],
      }),
    )
    expect(parsed).toMatchObject({
      messageId: "m1@example.com",
      inReplyTo: ["p@example.com"],
      references: ["r@example.com", "p@example.com"],
      from: { address: "dana@example.com", name: "Dana" },
    })
    expect(parsed.to.map((entry) => entry.address)).toEqual(["support@example.com", "other@example.com"])
    expect(parsed.cc.map((entry) => entry.address)).toEqual(["one@example.com", "two@example.com"])
    const report = await parseMessage(
      mime({
        from: "MAILER-DAEMON@example.com",
        report: {
          type: "delivery-status",
          parts: [
            { contentType: "text/plain", body: "Delivery failed." },
            {
              contentType: "message/delivery-status",
              body: "Reporting-MTA: dns; mx.example.com\r\n\r\nAction: failed",
            },
            { contentType: "text/rfc822-headers", body: "Message-ID: <sent-1@maane.example.com>\r\nSubject: hi" },
          ],
        },
      }),
    )
    expect(report.reportOriginalMessageId).toBe("sent-1@maane.example.com")
    expect(report.contentType).toMatchObject({
      value: "multipart/report",
      params: { "report-type": "delivery-status" },
    })
  })

  it("drops Message-IDs and addresses longer than mail allows, keeps the last references, and no Date is no date", async () => {
    const long = `${"x".repeat(MESSAGE_ID_MAX)}@example.com`
    const parsed = await parseMessage(
      mime({
        messageId: long,
        inReplyTo: long,
        references: Array.from({ length: MAX_REFERENCES + 20 }, (_, i) => `r${i}@example.com`),
        cc: `${"a".repeat(260)}@example.com, ok@example.com`,
        date: null,
      }),
    )
    expect(parsed).toMatchObject({ messageId: null, inReplyTo: [], date: null })
    expect(parsed.references).toHaveLength(MAX_REFERENCES)
    expect(parsed.references.at(-1)).toBe(`r${MAX_REFERENCES + 19}@example.com`)
    expect(parsed.cc.map((entry) => entry.address)).toEqual(["ok@example.com"])
    expect((await parseMessage(mime())).date?.toISOString()).toBe("2026-11-12T08:00:00.000Z")
  })

  it("treats an unparsable Date as no date, never the time of parsing", async () => {
    const raw = Buffer.from("From: dana@example.com\r\nDate: not a date at all\r\nSubject: x\r\n\r\nhi\r\n", "latin1")
    expect((await parseMessage(raw)).date).toBeNull()
  })

  it("finds a report's original Message-ID in an inline 7bit message/rfc822 part", async () => {
    const parsed = await parseMessage(
      mime({
        from: "MAILER-DAEMON@example.com",
        report: {
          type: "delivery-status",
          parts: [
            { contentType: "text/plain", body: "Delivery failed." },
            { contentType: "message/delivery-status", body: "Reporting-MTA: dns; mx.example.com" },
            {
              contentType: "message/rfc822\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: 7bit",
              body: "Message-ID: <sent-7@maane.example.com>\r\nSubject: hello\r\n\r\nThe original.",
            },
          ],
        },
      }),
    )
    expect(parsed.reportOriginalMessageId).toBe("sent-7@maane.example.com")
    // The returned message stays a part (scanned and kept like a file), not text of the report.
    expect(parsed.text).not.toContain("The original.")
  })

  it("reads a delivery report's recipients, each with its action and status, and nothing else (plan 3.3)", async () => {
    const report = (fields: string, type = "delivery-status", partType = "message/delivery-status") =>
      parseMessage(
        mime({
          from: "MAILER-DAEMON@example.com",
          report: {
            type,
            parts: [
              { contentType: "text/plain", body: "Delivery failed." },
              { contentType: partType, body: fields },
              { contentType: "text/rfc822-headers", body: "Message-ID: <sent-2@maane.example.com>" },
            ],
          },
        }),
      )
    const parsed = await report(
      [
        "Reporting-MTA: dns; mx.example.com",
        "Arrival-Date: Thu, 12 Nov 2026 10:00:00 +0200",
        "",
        "Original-Recipient: rfc822;Dana@Example.com",
        "Final-Recipient: rfc822; Dana@Example.com",
        "Action: FAILED",
        "Status: 5.1.1 (no such user)",
        "Diagnostic-Code: smtp; 550 5.1.1 <dana@example.com>: Recipient address rejected",
        "",
        "Final-Recipient: rfc822;<ron@example.com>",
        "Action: delayed",
        "Status: 4.4.1",
        "",
        "Final-Recipient: rfc822; noaction@example.com",
        "",
        "Final-Recipient: rfc822; odd@example.com",
        "Action: exploded",
        "Status: 9.9.9",
        "",
        "Final-Recipient: rfc822; nostatus@example.com",
        "Action: failed",
      ].join("\r\n"),
    )
    expect(parsed.deliveryReport).toEqual([
      { address: "dana@example.com", action: "failed", status: "5.1.1" },
      { address: "ron@example.com", action: "delayed", status: "4.4.1" },
      { address: "nostatus@example.com", action: "failed", status: null },
    ])
    expect(parsed.reportOriginalMessageId).toBe("sent-2@maane.example.com")
    // The main parse is as 2.3 stored it: the report's fields are in the text, and not a part.
    expect(parsed.text).toContain("Reporting-MTA")
    expect(parsed.parts.map((part) => part.declaredType)).toEqual(["text/rfc822-headers"])
    // A report that names no recipient reads as an empty list; RFC 6533's global form is read too.
    expect((await report("Reporting-MTA: dns; mx.example.com")).deliveryReport).toEqual([])
    expect(
      (
        await report(
          "Final-Recipient: utf-8; ron@example.com\r\nAction: failed",
          "delivery-status",
          "message/global-delivery-status",
        )
      ).deliveryReport,
    ).toEqual([{ address: "ron@example.com", action: "failed", status: null }])
    // A disposition notification (a read receipt) and an ordinary message have none.
    expect(
      (
        await report(
          "Final-Recipient: rfc822; dana@example.com\r\nOriginal-Message-ID: <sent-2@maane.example.com>\r\nDisposition: manual-action/MDN-sent-manually; displayed",
          "disposition-notification",
          "message/disposition-notification",
        )
      ).deliveryReport,
    ).toBeNull()
    expect((await parseMessage(mime())).deliveryReport).toBeNull()
  })

  it("collects the header values Maane keeps into one block for the scanner", async () => {
    const parsed = await parseMessage(
      mime({
        subject: "Order",
        from: "Dana <dana@example.com>",
        headers: [["X-Anything", "value"]],
        attachments: [{ fileName: "a.txt", contentType: "text/plain", content: Buffer.from("a") }],
      }),
    )
    const content = contentOf(parsed, {
      id: "g",
      folder: "inbox",
      receivedDateTime: null,
      internetMessageId: null,
      subject: "Graph subject",
      from: { address: "dana@example.com", name: "Graph name" },
    })
    const block = headerBlock(content.headers)
    for (const value of ["Order", "Dana", "X-Anything: value", "a.txt", "Graph subject", "Graph name"])
      expect(block).toContain(value)
  })

  it("gives the same content hash to the same message and another to other content", async () => {
    const raw = mime({ messageId: "same@example.com", text: { content: "one" } })
    expect((await parseMessage(raw)).contentHash).toBe((await parseMessage(Buffer.from(raw))).contentHash)
    const other = mime({ messageId: "same@example.com", text: { content: "two" } })
    expect((await parseMessage(other)).contentHash).not.toBe((await parseMessage(raw)).contentHash)
  })

  it("throws on a message mailparser cannot parse, and parses a malformed one as far as it can", async () => {
    await expect(
      parseMessage(Buffer.from(`Subject: x\r\nX-Long: ${"a".repeat(1_100_000)}\r\n\r\nbody\r\n`)),
    ).rejects.toThrow()
    const malformed = await parseMessage(
      Buffer.from(
        "Subject: broken\r\nContent-Type: multipart/mixed; boundary=XX\r\n\r\n--XX\r\nContent-Type: text/plain\r\n" +
          "Content-Transfer-Encoding: base64\r\n\r\n!!!not base64***\r\n--XX\r\nContent-Type: image/png\r\n",
        "latin1",
      ),
    )
    expect(malformed.subject).toBe("broken")
  })
})

describe("Graph errors", () => {
  it("tells an expired delta token and Entra's refusal from Graph's answers", async () => {
    const { GraphError } = await import("@microsoft/microsoft-graph-client")
    const graphError = (status: number, code: string | null, message = "") => {
      const error = new GraphError(status, message)
      error.code = code
      return error
    }
    expect(isExpiredDelta(graphError(410, null))).toBe(true)
    expect(isExpiredDelta(graphError(400, "syncStateNotFound"))).toBe(true)
    expect(isExpiredDelta(graphError(404, "ErrorItemNotFound"))).toBe(false)
    expect(describeGraphError(graphError(403, "ErrorAccessDenied"))).toEqual({
      problem: "access_denied",
      code: "ErrorAccessDenied",
      status: 403,
    })
    expect(
      describeGraphError(
        graphError(
          -1,
          "AuthenticationRequiredError",
          "invalid_client: Description: AADSTS7000215: Invalid client secret",
        ),
      ),
    ).toEqual({ problem: "credential", code: "AADSTS7000215", status: null })
    expect(describeGraphError(graphError(-1, "TypeError", "fetch failed"))).toEqual({
      problem: "network",
      code: "TypeError",
      status: null,
    })
    // A code that is not a plain identifier is never repeated.
    expect(describeGraphError(graphError(500, "<b>x</b>")).code).toBeNull()
  })
})
