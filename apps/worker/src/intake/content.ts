// What of a parsed message is stored, and the scan of its text fields (plan 2.3, review G1). The structured fields
// threading and matching need (Message-ID, In-Reply-To, References, the From, To, and Cc addresses, the Date, the content
// type) are bounded and always kept. The text fields are scanned like files by the same file service before the store
// transaction: the text body, the sanitized HTML, and the header block (the subject, the display names, every header
// line, Graph's subject and sender name, and the parts' file names, types, and content IDs, as one text). A field the
// scanner flags (infected or a blocked type) is not stored, the message is flagged `blocked_content`, and one audit row
// names the fields and signatures. A field that cannot be scanned follows the unavailable policy like a file: `waiting`
// (not stored; the retry fetches the message again and scans it) or `not_scanned` (stored). Text the scanner does not
// flag is stored as it is: Maane does not decode base64 or anything else that appears inside ordinary text.

import { SYSTEM, writeAudit } from "@maane/server/audit"
import type { Db } from "@maane/server/db/client"
import { type FieldScan, type PartStatus, STORED_STATUSES, type TextField } from "@maane/shared"
import { type FileService, FileTooLargeError } from "../files/service.ts"
import { classify } from "./classify.ts"
import type { MailAddress, ParsedMessage, ReportRecipient } from "./parse.ts"
import { wellFormed } from "./text.ts"

/** Graph's metadata of a message, as a record keeps it. */
export interface GraphMeta {
  id: string
  folder: string
  receivedDateTime: string | null
  internetMessageId: string | null
  subject: string | null
  from: { address: string | null; name: string | null } | null
}

/** The content type as stored: a bounded media type, and a report's type for classification. */
export interface StoredContentType {
  value: string
  reportType: string | null
}

const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]{1,63}\/[a-z0-9!#$&^_.+-]{1,63}$/
const TOKEN = /^[a-z0-9.+-]{1,64}$/

/**
 * mailparser's parsed content type (its parser already drops an RFC 822 comment), bounded: a media type that is not a
 * plain token pair reads as application/octet-stream, and a report type that is not one token is none.
 */
export function storedContentType(type: ParsedMessage["contentType"]): StoredContentType {
  const report = (type.params["report-type"] ?? "").trim()
  return {
    value: MEDIA_TYPE.test(type.value) ? type.value : "application/octet-stream",
    reportType: TOKEN.test(report) ? report : null,
  }
}

/** Everything of a message Maane may store, well formed, before the text fields are scanned. */
export interface MessageContent {
  structured: {
    messageIdHeader: string | null
    inReplyTo: string[]
    references: string[]
    fromAddress: string | null
    to: string[]
    cc: string[]
    sentAt: Date | null
    contentType: StoredContentType
    reportOriginalMessageId: string | null
    deliveryReport: ReportRecipient[] | null
    graph: Omit<GraphMeta, "subject" | "from"> & { fromAddress: string | null }
  }
  /** The header block: what the scan of `headers` decides about. */
  headers: {
    subject: string | null
    fromName: string | null
    toNames: (string | null)[]
    ccNames: (string | null)[]
    lines: { key: string; line: string }[]
    graphSubject: string | null
    graphFromName: string | null
    parts: { fileName: string | null; declaredType: string | null; contentId: string | null }[]
  }
  text: string | null
  html: string | null
  /** A decoded string held U+0000 or an unpaired surrogate (replaced by U+FFFD). */
  invalidCharacters: boolean
}

export function contentOf(parsed: ParsedMessage, meta: GraphMeta): MessageContent {
  const names = (list: MailAddress[]) => list.map((entry) => entry.name)
  const fixed = wellFormed({
    structured: {
      messageIdHeader: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      fromAddress: parsed.from?.address ?? null,
      to: parsed.to.map((entry) => entry.address),
      cc: parsed.cc.map((entry) => entry.address),
      reportOriginalMessageId: parsed.reportOriginalMessageId,
      deliveryReport: parsed.deliveryReport,
      graph: {
        id: meta.id,
        folder: meta.folder,
        receivedDateTime: meta.receivedDateTime,
        internetMessageId: meta.internetMessageId?.slice(0, 1000) ?? null,
        fromAddress: meta.from?.address?.slice(0, 254) ?? null,
      },
    },
    headers: {
      subject: parsed.subject,
      fromName: parsed.from?.name ?? null,
      toNames: names(parsed.to),
      ccNames: names(parsed.cc),
      lines: parsed.headers,
      graphSubject: meta.subject,
      graphFromName: meta.from?.name ?? null,
      parts: parsed.parts.map((part) => ({
        fileName: part.fileName,
        declaredType: part.declaredType,
        contentId: part.contentId,
      })),
    },
    text: parsed.text,
    html: parsed.html,
  })
  return {
    ...fixed.value,
    structured: { ...fixed.value.structured, sentAt: parsed.date, contentType: storedContentType(parsed.contentType) },
    invalidCharacters: fixed.changed,
  }
}

/** The header block as one text the scanner reads: every kept header value on its own line. */
export function headerBlock(headers: MessageContent["headers"]): string {
  const values = [
    headers.subject,
    headers.fromName,
    ...headers.toNames,
    ...headers.ccNames,
    headers.graphSubject,
    headers.graphFromName,
    ...headers.lines.map((header) => header.line),
    ...headers.parts.flatMap((part) => [part.fileName, part.declaredType, part.contentId]),
  ]
  return values.filter((value): value is string => typeof value === "string" && value !== "").join("\n")
}

/** The text of each field that exists, as the scanner reads it. */
export function fieldTexts(content: MessageContent): Partial<Record<TextField, string>> {
  const texts: Partial<Record<TextField, string>> = {}
  if (content.text !== null && content.text !== "") texts.text = content.text
  if (content.html !== null && content.html !== "") texts.html = content.html
  const block = headerBlock(content.headers)
  if (block !== "") texts.headers = block
  return texts
}

/** Scans the given fields with the file service, as files without a name. */
export async function scanFields(
  files: FileService,
  texts: Partial<Record<TextField, string>>,
): Promise<Partial<Record<TextField, FieldScan>>> {
  const scans: Partial<Record<TextField, FieldScan>> = {}
  for (const [field, text] of Object.entries(texts) as [TextField, string][]) {
    try {
      const outcome = await files.scan(Buffer.from(text, "utf8"), null)
      scans[field] = {
        status: outcome.status,
        signature: outcome.signature,
        blockedBy: outcome.status === "blocked_type" ? outcome.blockedBy : null,
      }
    } catch (error) {
      if (!(error instanceof FileTooLargeError)) throw error
      scans[field] = { status: "too_large", signature: null, blockedBy: null }
    }
  }
  return scans
}

/** A field whose scan lets it be stored: clean, not fully scanned, or not scanned (the policy allows). */
export const storable = (scan: FieldScan | undefined) =>
  scan === undefined || (STORED_STATUSES as readonly PartStatus[]).includes(scan.status)

/** A field the scanner refused for good: infected, a blocked type, or too large to scan. */
export const refused = (scan: FieldScan | undefined) =>
  scan !== undefined && ["infected", "blocked_type", "too_large"].includes(scan.status)

/** The message columns the content and its field scans give. A field not storable is null (the headers empty). */
export function columnsOf(content: MessageContent, scans: Partial<Record<TextField, FieldScan>>) {
  const s = content.structured
  const h = content.headers
  const headersOk = storable(scans.headers)
  // Classified from the parsed headers before any is dropped (review G13): only the bounded result is stored.
  const classification = classify({ headers: h.lines, contentType: s.contentType, from: s.fromAddress })
  const named = (addresses: string[], names: (string | null)[]) =>
    addresses.map((address, index) => ({ address, name: headersOk ? (names[index] ?? null) : null }))
  return {
    messageIdHeader: s.messageIdHeader,
    inReplyTo: s.inReplyTo,
    references: s.references,
    fromAddress: s.fromAddress,
    fromName: headersOk ? h.fromName : null,
    toAddresses: named(s.to, h.toNames),
    ccAddresses: named(s.cc, h.ccNames),
    sentAt: s.sentAt,
    contentType: s.contentType,
    reportOriginalMessageId: s.reportOriginalMessageId,
    deliveryReport: s.deliveryReport,
    subject: headersOk ? h.subject : null,
    headers: headersOk ? h.lines : [],
    graph: {
      id: s.graph.id,
      folder: s.graph.folder,
      receivedDateTime: s.graph.receivedDateTime,
      internetMessageId: s.graph.internetMessageId,
      subject: headersOk ? h.graphSubject : null,
      from: { address: s.graph.fromAddress, name: headersOk ? h.graphFromName : null },
    },
    textBody: storable(scans.text) ? content.text : null,
    htmlBody: storable(scans.html) ? content.html : null,
    fieldScans: scans,
    classification: classification.automated ? "automated" : "customer",
    automatedReasons: classification.signs,
    possiblyAutomated: classification.possiblyAutomated,
  }
}

/** The part names the header block's scan allows, by position. */
export function partNamesOf(content: MessageContent, scans: Partial<Record<TextField, FieldScan>>) {
  const ok = storable(scans.headers)
  return content.headers.parts.map((part) => (ok ? part : { fileName: null, declaredType: null, contentId: null }))
}

/**
 * The audit row of the text fields a scan refused (G1), written once: only the fields that were not refused before.
 * Names the fields and the signatures or types, never the content.
 */
export async function auditBlockedFields(
  tx: Pick<Db, "insert">,
  messageId: string,
  before: Partial<Record<TextField, FieldScan>>,
  after: Partial<Record<TextField, FieldScan>>,
): Promise<boolean> {
  const fields = (Object.entries(after) as [TextField, FieldScan][])
    .filter(([field, scan]) => refused(scan) && !refused(before[field]))
    .map(([field, scan]) => ({ field, reason: scan.status, signature: scan.signature, type: scan.blockedBy }))
  if (fields.length === 0) return false
  await writeAudit(tx, SYSTEM, {
    action: "message.content_blocked",
    entityType: "message",
    entityId: messageId,
    details: { message: messageId, fields },
  })
  return true
}

/** Whether any field still waits for the scanner. */
export const fieldsWaiting = (scans: unknown) =>
  typeof scans === "object" &&
  scans !== null &&
  Object.values(scans as Record<string, FieldScan>).some((scan) => scan?.status === "waiting")
