import { createHash } from "node:crypto"
import { type AddressObject, type Attachment, type HeaderValue, simpleParser } from "mailparser"
import { sanitizeMailHtml, textFromHtml } from "./sanitize.ts"

export interface MailAddress {
  address: string
  name: string | null
}

export interface MailPart {
  index: number
  kind: "attachment" | "inline"
  fileName: string | null
  declaredType: string | null
  contentId: string | null
  content: Buffer
}

export interface ParsedMessage {
  messageId: string | null
  inReplyTo: string[]
  references: string[]
  from: MailAddress | null
  to: MailAddress[]
  cc: MailAddress[]
  date: Date | null
  subject: string | null
  headers: { key: string; line: string }[]
  contentType: { value: string; params: Record<string, string> }
  text: string | null
  html: string | null
  parts: MailPart[]
  contentHash: string
  reportOriginalMessageId: string | null
  deliveryReport: ReportRecipient[] | null
}

export interface ReportRecipient {
  address: string
  action: string
  status: string | null
}

const ANGLE_ID = /<([^<>\s]+)>/g

export const MESSAGE_ID_MAX = 998
export const ADDRESS_MAX_LENGTH = 254
export const MAX_REFERENCES = 50

export function messageIds(value: string | string[] | undefined | null): string[] {
  const texts = Array.isArray(value) ? value : value ? [value] : []
  const ids: string[] = []
  for (const text of texts) {
    const found = [...text.matchAll(ANGLE_ID)].map((match) => match[1] ?? "")
    if (found.length > 0) ids.push(...found)
    else if (text.trim() && !/\s/.test(text.trim())) ids.push(text.trim())
  }
  return [...new Set(ids.filter((id) => id && Buffer.byteLength(id) <= MESSAGE_ID_MAX))]
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

const REPORT_ACTIONS = ["failed", "delayed", "delivered", "relayed", "expanded"]
export const REPORT_RECIPIENTS_MAX = 100

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

const OPTIONS = { skipImageLinks: true, skipHtmlToText: true, skipTextLinks: true } as const

function rawHeader(lines: readonly { key: string; line: string }[], name: string): string | null {
  const line = lines.find((header) => header.key === name)?.line
  if (line === undefined) return null
  const colon = line.indexOf(":")
  return (colon >= 0 ? line.slice(colon + 1) : "").replace(/\r?\n[ \t]+/g, " ").trim()
}

function dateOf(lines: readonly { key: string; line: string }[], parsed: Date | undefined): Date | null {
  const value = rawHeader(lines, "date")
  if (value === null || Number.isNaN(new Date(value).getTime())) return null
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")

export async function parseMessage(raw: Uint8Array): Promise<ParsedMessage> {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  const mail = await simpleParser(bytes, {
    ...OPTIONS,
    ignoreEmbedded: true,
  })
  const contentType = contentTypeOf(mail.headers.get("content-type"))
  const decodedText = typeof mail.text === "string" ? mail.text : null
  const decodedHtml = typeof mail.html === "string" ? mail.html : null
  const html = decodedHtml === null ? null : sanitizeMailHtml(decodedHtml)
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
