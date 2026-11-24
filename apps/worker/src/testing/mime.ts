import { randomBytes } from "node:crypto"
import iconv from "iconv-lite"

export const fromCodePoints = (...points: number[]) => String.fromCodePoint(...points)

export const SHALOM = fromCodePoints(0x5e9, 0x5dc, 0x5d5, 0x5dd)
export const SHALOM_OLAM = `${SHALOM} ${fromCodePoints(0x5e2, 0x5d5, 0x5dc, 0x5dd)}`
export const INVOICE = fromCodePoints(0x5d7, 0x5e9, 0x5d1, 0x5d5, 0x5e0, 0x5d9, 0x5ea)

export const windows1255 = (text: string): Buffer => iconv.encode(text, "windows-1255")

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
    lines.push(out.endsWith(" ") ? `${out.slice(0, -1)}=20` : out)
  }
  return lines.join("\r\n")
}

export const base64Lines = (bytes: Buffer) => (bytes.toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n")

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

export const rfc2231 = (text: string) =>
  `UTF-8''${[...Buffer.from(text, "utf8")].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("")}`

export interface Body {
  content: string | Buffer
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
  messageId?: string | null
  from?: string
  to?: string
  cc?: string
  subject?: string
  date?: string | null
  inReplyTo?: string
  references?: string[]
  headers?: [string, string][]
  text?: Body
  html?: Body
  attachments?: Attachment[]
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
