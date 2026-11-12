// Parsing a raw message (plan 2.3, P4): mailparser's simpleParser with skipImageLinks, so no inline image becomes a
// `data:` URL inside the HTML, and skipHtmlToText, so no text is made from the unsanitized HTML. The HTML is sanitized
// here, before anything is stored; the text is the message's own text part, or, without one, text made from the
// sanitized HTML. Strings are made well formed when the row is built (text.ts), not here, so the content hash is of
// what the message decoded to.

import { createHash } from "node:crypto"
import { type AddressObject, type Attachment, type HeaderValue, simpleParser } from "mailparser"
import { sanitizeMailHtml, textFromHtml } from "./sanitize.ts"

export interface MailAddress {
  /** In lower case. */
  address: string
  name: string | null
}

export interface MailPart {
  /** Its position among the message's attachments, as mailparser lists them. */
  index: number
  kind: "attachment" | "inline"
  fileName: string | null
  declaredType: string | null
  contentId: string | null
  content: Buffer
}

export interface ParsedMessage {
  /** Message-ID without its angle brackets. */
  messageId: string | null
  inReplyTo: string[]
  references: string[]
  from: MailAddress | null
  to: MailAddress[]
  cc: MailAddress[]
  date: Date | null
  subject: string | null
  /** Every header line as received. */
  headers: { key: string; line: string }[]
  /** The top-level content type and its parameters, lower case. */
  contentType: { value: string; params: Record<string, string> }
  text: string | null
  /** Sanitized. */
  html: string | null
  parts: MailPart[]
  /** SHA-256 over the decoded text, the decoded HTML, and the hash of every part, in order. */
  contentHash: string
  /** A delivery or disposition report's original Message-ID (RFC 3464, RFC 8098), without brackets. */
  reportOriginalMessageId: string | null
}

const ANGLE_ID = /<([^<>\s]+)>/g

/**
 * Bounds on what a sender controls that becomes a key (plan 2.3): a Message-ID longer than a header line may be
 * (RFC 5322, 998 characters) and an address longer than SMTP allows (RFC 5321, 254) are dropped, and only the last
 * MAX_REFERENCES of a References header are kept, so no message can overflow an index entry or flood the pending
 * references of a ticket.
 */
export const MESSAGE_ID_MAX = 998
export const ADDRESS_MAX_LENGTH = 254
export const MAX_REFERENCES = 50

/** The message IDs in a header value, without brackets: each `<...>`, or the whole trimmed value when it has none. */
export function messageIds(value: string | string[] | undefined | null): string[] {
  const texts = Array.isArray(value) ? value : value ? [value] : []
  const ids: string[] = []
  for (const text of texts) {
    const found = [...text.matchAll(ANGLE_ID)].map((match) => match[1] ?? "")
    if (found.length > 0) ids.push(...found)
    else if (text.trim() && !/\s/.test(text.trim())) ids.push(text.trim())
  }
  return [...new Set(ids.filter((id) => id && id.length <= MESSAGE_ID_MAX))]
}

function addresses(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
  const objects = Array.isArray(value) ? value : value ? [value] : []
  const result: MailAddress[] = []
  const add = (entry: { address?: string; name?: string; group?: unknown[] }) => {
    const address = entry.address?.trim().toLowerCase()
    if (address && address.length <= ADDRESS_MAX_LENGTH) result.push({ address, name: entry.name?.trim() || null })
    for (const member of (entry.group ?? []) as { address?: string; name?: string }[]) add(member)
  }
  for (const object of objects) for (const entry of object.value) add(entry)
  return result
}

function contentTypeOf(value: HeaderValue | undefined): ParsedMessage["contentType"] {
  if (value && typeof value === "object" && "value" in value && typeof value.value === "string") {
    const params: Record<string, string> = {}
    for (const [key, param] of Object.entries((value as { params?: Record<string, string> }).params ?? {}))
      params[key.toLowerCase()] = String(param).toLowerCase()
    return { value: value.value.toLowerCase(), params }
  }
  return { value: "text/plain", params: {} }
}

/**
 * The original Message-ID a report names (RFC 3464, RFC 8098): the returned headers or message (`text/rfc822-headers`,
 * `message/rfc822`, which mailparser keeps as attachments with its documented `ignoreEmbedded` option), or a
 * disposition notification's `Original-Message-ID`, each read by mailparser's own header parser.
 */
async function reportOriginal(type: ParsedMessage["contentType"], attachments: Attachment[]): Promise<string | null> {
  if (type.value !== "multipart/report") return null
  for (const part of attachments) {
    const declared = part.contentType.toLowerCase()
    if (!["text/rfc822-headers", "message/rfc822", "message/disposition-notification"].includes(declared)) continue
    const nested = await simpleParser(part.content, { ...OPTIONS, ignoreEmbedded: true }).catch(() => null)
    if (!nested) continue
    const named =
      declared === "message/disposition-notification" ? nested.headers.get("original-message-id") : nested.messageId
    const id = typeof named === "string" ? messageIds(named)[0] : undefined
    if (id) return id
  }
  return null
}

/** simpleParser's options: no data: URLs for inline images, no text from unsanitized HTML, no links in text. */
const OPTIONS = { skipImageLinks: true, skipHtmlToText: true, skipTextLinks: true } as const

/** A header's raw value from mailparser's headerLines (the text after the first colon, unfolded), or null. */
function rawHeader(lines: readonly { key: string; line: string }[], name: string): string | null {
  const line = lines.find((header) => header.key === name)?.line
  if (line === undefined) return null
  const colon = line.indexOf(":")
  return (colon >= 0 ? line.slice(colon + 1) : "").replace(/\r?\n[ \t]+/g, " ").trim()
}

/**
 * The message's own Date: mailparser parses the header with `new Date(value)` and, when that fails, uses the time of
 * parsing. Maane takes mailparser's date only when the raw header (its documented headerLines) parses the same way,
 * so a missing or unparsable Date is no date, and two copies of one message keep equal dates.
 */
function dateOf(lines: readonly { key: string; line: string }[], parsed: Date | undefined): Date | null {
  const value = rawHeader(lines, "date")
  if (value === null || Number.isNaN(new Date(value).getTime())) return null
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")

/** Parses a raw message. Throws when mailparser cannot (the caller records the message for review). */
export async function parseMessage(raw: Uint8Array): Promise<ParsedMessage> {
  // ignoreEmbedded: an embedded message (a forward, a returned message in a report) stays an attachment, scanned and
  // kept like any other part, instead of being flattened into the text.
  const mail = await simpleParser(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), {
    ...OPTIONS,
    ignoreEmbedded: true,
  })
  const contentType = contentTypeOf(mail.headers.get("content-type"))
  const decodedText = typeof mail.text === "string" ? mail.text : null
  const decodedHtml = typeof mail.html === "string" ? mail.html : null
  const html = decodedHtml === null ? null : sanitizeMailHtml(decodedHtml)
  // Without a text part mailparser gives an empty text: then the text is made from the sanitized HTML.
  const text = decodedText?.trim() ? decodedText : html === null ? decodedText : textFromHtml(html)
  const parts: MailPart[] = mail.attachments.map((attachment, index) => ({
    index,
    kind: attachment.contentDisposition === "inline" || attachment.related ? "inline" : "attachment",
    fileName: attachment.filename?.trim() || null,
    declaredType: attachment.contentType?.toLowerCase() || null,
    contentId: attachment.cid?.trim() || null,
    content: attachment.content,
  }))
  const contentHash = sha256(
    JSON.stringify({ text: decodedText, html: decodedHtml, parts: parts.map((part) => sha256(part.content)) }),
  )
  const from = addresses(mail.from)[0] ?? null
  return {
    messageId: messageIds(mail.messageId)[0] ?? null,
    inReplyTo: messageIds(mail.inReplyTo).slice(0, MAX_REFERENCES),
    references: messageIds(mail.references).slice(-MAX_REFERENCES),
    from,
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    date: dateOf(mail.headerLines, mail.date),
    subject: typeof mail.subject === "string" ? mail.subject : null,
    headers: mail.headerLines.map((header) => ({ key: header.key, line: header.line })),
    contentType,
    text,
    html,
    parts,
    contentHash,
    reportOriginalMessageId: await reportOriginal(contentType, mail.attachments),
  }
}
