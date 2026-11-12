// MIME fixtures for intake tests, built at run time. Hebrew never appears as a literal in a tracked file: it is built
// from code points here and encoded as each test needs (UTF-8, Windows-1255, quoted-printable, base64, encoded words,
// RFC 2231 file names). Addresses use example.com.

import { randomBytes } from "node:crypto"

/** Text from code points (Hebrew letters are U+05D0 to U+05EA). */
export const fromCodePoints = (...points: number[]) => String.fromCodePoint(...points)

/** A Hebrew word ("shalom"), a phrase ("shalom olam"), and a file name stem ("hashbonit", an invoice). */
export const SHALOM = fromCodePoints(0x5e9, 0x5dc, 0x5d5, 0x5dd)
export const SHALOM_OLAM = `${SHALOM} ${fromCodePoints(0x5e2, 0x5d5, 0x5dc, 0x5dd)}`
export const INVOICE = fromCodePoints(0x5d7, 0x5e9, 0x5d1, 0x5d5, 0x5e0, 0x5d9, 0x5ea)

/**
 * Windows-1255 for ASCII and the 27 Hebrew letters, which the code page maps in order: U+05D0 to U+05EA become 0xE0 to
 * 0xFA. Anything else is refused, so a fixture cannot hold a character this does not map.
 */
export function windows1255(text: string): Buffer {
  const bytes: number[] = []
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0
    if (point < 0x80) bytes.push(point)
    else if (point >= 0x5d0 && point <= 0x5ea) bytes.push(point - 0x5d0 + 0xe0)
    else throw new Error(`windows1255: U+${point.toString(16)} is not mapped here`)
  }
  return Buffer.from(bytes)
}

/** Quoted-printable (RFC 2045) of bytes, CRLF line ends kept as hard breaks, soft breaks under 76 characters. */
export function quotedPrintable(bytes: Buffer): string {
  const lines: string[] = []
  for (const line of bytes.toString("latin1").split("\r\n")) {
    let out = ""
    let width = 0
    for (const char of line) {
      const code = char.charCodeAt(0)
      const plain = (code >= 33 && code <= 126 && code !== 61) || code === 32
      const piece = plain ? char : `=${code.toString(16).toUpperCase().padStart(2, "0")}`
      if (width + piece.length > 75) {
        out += "=\r\n"
        width = 0
      }
      out += piece
      width += piece.length
    }
    // A space at the end of a line would be lost in transport.
    lines.push(out.endsWith(" ") ? `${out.slice(0, -1)}=20` : out)
  }
  return lines.join("\r\n")
}

/** Base64 in lines of 76 characters. */
export const base64Lines = (bytes: Buffer) => (bytes.toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n")

/** An RFC 2047 encoded word of UTF-8 text (B or Q). */
export function encodedWord(text: string, encoding: "B" | "Q" = "B"): string {
  const bytes = Buffer.from(text, "utf8")
  if (encoding === "B") return `=?UTF-8?B?${bytes.toString("base64")}?=`
  let q = ""
  for (const byte of bytes) {
    const char = String.fromCharCode(byte)
    q += /[A-Za-z0-9]/.test(char) ? char : byte === 32 ? "_" : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`
  }
  return `=?UTF-8?Q?${q}?=`
}

/** An RFC 2231 parameter value of UTF-8 text: `UTF-8''%D7%A9...`. */
export const rfc2231 = (text: string) =>
  `UTF-8''${[...Buffer.from(text, "utf8")].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("")}`

export interface Body {
  /** The decoded content. */
  content: string | Buffer
  /** `utf-8` (text is encoded as UTF-8) or `windows-1255` (text is encoded with windows1255()). */
  charset?: "utf-8" | "windows-1255"
  encoding?: "base64" | "quoted-printable" | "8bit" | "7bit"
}

export interface Attachment {
  fileName: string | null
  contentType: string
  content: Buffer
  inline?: boolean
  contentId?: string
}

export interface MimeOptions {
  /** Without brackets; null for a message with no Message-ID. Default: a new one. */
  messageId?: string | null
  from?: string
  to?: string
  cc?: string
  /** The header value as written (an encoded word stays as given). */
  subject?: string
  /** The Date header as written; null for none. */
  date?: string | null
  inReplyTo?: string
  references?: string[]
  /** More header lines, as written. */
  headers?: [string, string][]
  text?: Body
  html?: Body
  attachments?: Attachment[]
  /** A whole multipart/report instead of a body: its report type and its parts, as written. */
  report?: { type: string; parts: { contentType: string; body: string }[] }
}

const boundary = () => `=_maane_${randomBytes(8).toString("hex")}`

function encodeBody(body: Body, type: string): string {
  const charset = body.charset ?? "utf-8"
  const bytes =
    typeof body.content === "string"
      ? charset === "windows-1255"
        ? windows1255(body.content)
        : Buffer.from(body.content, "utf8")
      : body.content
  const encoding = body.encoding ?? "base64"
  const encoded =
    encoding === "base64"
      ? base64Lines(bytes)
      : encoding === "quoted-printable"
        ? quotedPrintable(bytes)
        : bytes.toString("latin1")
  return `Content-Type: ${type}; charset=${charset}\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n${encoded}\r\n`
}

function encodeAttachment(attachment: Attachment): string {
  const name = attachment.fileName
  const ascii = name === null || /^[\x20-\x7e]*$/.test(name)
  const typeName = name === null ? "" : ascii ? `; name="${name}"` : `; name="${encodedWord(name)}"`
  const disposition = attachment.inline ? "inline" : "attachment"
  const dispositionName = name === null ? "" : ascii ? `; filename="${name}"` : `; filename*=${rfc2231(name)}`
  const id = attachment.contentId ? `Content-ID: <${attachment.contentId}>\r\n` : ""
  return (
    `Content-Type: ${attachment.contentType}${typeName}\r\nContent-Disposition: ${disposition}${dispositionName}\r\n` +
    `${id}Content-Transfer-Encoding: base64\r\n\r\n${base64Lines(attachment.content)}\r\n`
  )
}

function multipart(type: string, parts: string[]): string {
  const mark = boundary()
  return `Content-Type: ${type}; boundary="${mark}"\r\n\r\n${parts.map((part) => `--${mark}\r\n${part}`).join("")}--${mark}--\r\n`
}

/** A whole message as bytes (CRLF line ends). */
export function mime(options: MimeOptions = {}): Buffer {
  const messageId =
    options.messageId === undefined ? `${randomBytes(8).toString("hex")}@mail.example.com` : options.messageId
  const head: string[] = [
    `From: ${options.from ?? "Dana Customer <dana@example.com>"}`,
    `To: ${options.to ?? "support@example.com"}`,
  ]
  if (options.cc) head.push(`Cc: ${options.cc}`)
  head.push(`Subject: ${options.subject ?? "A question"}`)
  if (options.date !== null) head.push(`Date: ${options.date ?? "Thu, 12 Nov 2026 10:00:00 +0200"}`)
  if (messageId !== null) head.push(`Message-ID: <${messageId}>`)
  if (options.inReplyTo) head.push(`In-Reply-To: <${options.inReplyTo}>`)
  if (options.references?.length) head.push(`References: ${options.references.map((id) => `<${id}>`).join(" ")}`)
  for (const [name, value] of options.headers ?? []) head.push(`${name}: ${value}`)
  head.push("MIME-Version: 1.0")

  let body: string
  if (options.report) {
    body = multipart(
      `multipart/report; report-type=${options.report.type}`,
      options.report.parts.map((part) => `Content-Type: ${part.contentType}\r\n\r\n${part.body}\r\n`),
    )
  } else {
    const text = options.text ? encodeBody(options.text, "text/plain") : null
    const html = options.html ? encodeBody(options.html, "text/html") : null
    let main = text && html ? multipart("multipart/alternative", [text, html]) : (text ?? html)
    main ??= encodeBody({ content: "" }, "text/plain")
    const inline = (options.attachments ?? []).filter((attachment) => attachment.inline)
    const attached = (options.attachments ?? []).filter((attachment) => !attachment.inline)
    if (inline.length) main = multipart("multipart/related", [main, ...inline.map(encodeAttachment)])
    if (attached.length) main = multipart("multipart/mixed", [main, ...attached.map(encodeAttachment)])
    body = main
  }
  return Buffer.from(`${head.join("\r\n")}\r\n${body}`, "latin1")
}
