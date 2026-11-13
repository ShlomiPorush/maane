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
  /**
   * A delivery status notification's recipients (RFC 3464), each as validated tokens; empty when it names none. Null
   * for any other message, a disposition notification (a read receipt) included.
   */
  deliveryReport: ReportRecipient[] | null
}

/** One recipient of a delivery status notification: its final recipient, its action, and its status code. */
export interface ReportRecipient {
  /** In lower case. */
  address: string
  /** RFC 3464 2.3.3: failed, delayed, delivered, relayed, or expanded. Only `failed` is a bounce. */
  action: string
  /** RFC 3464 2.3.4, such as `5.1.1`, or null when the group has none Maane can read. */
  status: string | null
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

/** RFC 3464's actions. */
const REPORT_ACTIONS = ["failed", "delayed", "delivered", "relayed", "expanded"]
/** The most recipients of one report Maane keeps. */
export const REPORT_RECIPIENTS_MAX = 100

/**
 * The recipients of a delivery status notification (RFC 3464, and RFC 6533's global form): mailparser's documented
 * `keepDeliveryStatus` keeps the `message/delivery-status` part as an attachment (the main parse leaves it in the
 * text, as 2.3 stores it), and each of its field groups, separated by a blank line, is read by mailparser's own header
 * parser. Only a group with a Final-Recipient and a known Action counts; free text (Diagnostic-Code) is never kept.
 */
async function deliveryReport(raw: Buffer, type: ParsedMessage["contentType"]): Promise<ReportRecipient[] | null> {
  if (type.value !== "multipart/report" || type.params["report-type"] !== "delivery-status") return null
  const mail = await simpleParser(raw, { ...OPTIONS, ignoreEmbedded: true, keepDeliveryStatus: true }).catch(() => null)
  const part = mail?.attachments.find((attachment) =>
    ["message/delivery-status", "message/global-delivery-status"].includes(attachment.contentType.toLowerCase()),
  )
  if (!part) return []
  const recipients: ReportRecipient[] = []
  for (const group of part.content.toString("utf8").split(/\r?\n[ \t]*\r?\n/)) {
    if (recipients.length >= REPORT_RECIPIENTS_MAX) break
    if (!group.trim()) continue
    const fields = await simpleParser(Buffer.from(`${group.trim()}\r\n\r\n`, "utf8"), OPTIONS).catch(() => null)
    const value = (name: string) => {
      const found = fields?.headers.get(name)
      return typeof found === "string" ? found.trim() : null
    }
    const final = value("final-recipient")
    const action = value("action")?.toLowerCase() ?? null
    if (!final || !action || !REPORT_ACTIONS.includes(action)) continue
    // "rfc822; someone@example.com" (or RFC 6533's "utf-8; ..."): the address after the type.
    const semicolon = final.indexOf(";")
    const address = (semicolon >= 0 ? final.slice(semicolon + 1) : final)
      .trim()
      .replace(/^<(.*)>$/, "$1")
      .toLowerCase()
    if (address.length > ADDRESS_MAX_LENGTH || !/^[^\s@<>]+@[^\s@<>]+$/.test(address)) continue
    const status = value("status")?.split(/\s/)[0] ?? null
    recipients.push({ address, action, status: status && /^[245]\.\d{1,3}\.\d{1,3}$/.test(status) ? status : null })
  }
  return recipients
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
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  const mail = await simpleParser(bytes, {
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
    deliveryReport: await deliveryReport(bytes, contentType),
  }
}
