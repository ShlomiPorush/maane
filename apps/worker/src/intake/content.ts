import { SYSTEM, writeAudit } from "@maane/server/audit"
import type { Db } from "@maane/server/db/client"
import { message } from "@maane/server/db/schema"
import { type FieldScan, type PartStatus, STORED_STATUSES, type TextField } from "@maane/shared"
import { sql } from "drizzle-orm"
import { type FileService, FileTooLargeError } from "../files/service.ts"
import { type ClassifyInput, classify } from "./classify.ts"
import type { MailAddress, ParsedMessage, ReportRecipient } from "./parse.ts"
import { wellFormed } from "./text.ts"

export interface GraphMeta {
  id: string
  folder: string
  receivedDateTime: string | null
  internetMessageId: string | null
  subject: string | null
  from: { address: string | null; name: string | null } | null
}

export const NOT_READ_YET = sql`(${message.content} = 'unavailable' and 'not_read' = any(${message.reviewFlags}))`

export function mediaTypeOf(type: ParsedMessage["contentType"]): ClassifyInput["contentType"] {
  return { value: type.value, reportType: type.params["report-type"]?.trim() ?? null }
}

export interface MessageContent {
  structured: {
    messageIdHeader: string | null
    inReplyTo: string[]
    references: string[]
    fromAddress: string | null
    to: string[]
    cc: string[]
    sentAt: Date | null
    contentType: ClassifyInput["contentType"]
    reportOriginalMessageId: string | null
    deliveryReport: ReportRecipient[] | null
    graph: Omit<GraphMeta, "subject" | "from"> & { fromAddress: string | null }
  }
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
    structured: { ...fixed.value.structured, sentAt: parsed.date, contentType: mediaTypeOf(parsed.contentType) },
    invalidCharacters: fixed.changed,
  }
}

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

export function fieldTexts(content: MessageContent): Partial<Record<TextField, string>> {
  const texts: Partial<Record<TextField, string>> = {}
  if (content.text !== null && content.text !== "") texts.text = content.text
  if (content.html !== null && content.html !== "") texts.html = content.html
  const block = headerBlock(content.headers)
  if (block !== "") texts.headers = block
  return texts
}

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

export const storable = (scan: FieldScan | undefined) =>
  scan === undefined || (STORED_STATUSES as readonly PartStatus[]).includes(scan.status)

export const refused = (scan: FieldScan | undefined) =>
  scan !== undefined && ["infected", "blocked_type", "too_large"].includes(scan.status)

export function columnsOf(content: MessageContent, scans: Partial<Record<TextField, FieldScan>>) {
  const s = content.structured
  const h = content.headers
  const headersOk = storable(scans.headers)
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
    reportOriginalMessageId: s.reportOriginalMessageId,
    deliveryReport: s.deliveryReport,
    subject: headersOk ? h.subject : null,
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

export function partNamesOf(content: MessageContent, scans: Partial<Record<TextField, FieldScan>>) {
  const ok = storable(scans.headers)
  return content.headers.parts.map((part) => (ok ? part : { fileName: null, declaredType: null, contentId: null }))
}

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

export const fieldsWaiting = (scans: unknown) =>
  typeof scans === "object" &&
  scans !== null &&
  Object.values(scans as Record<string, FieldScan>).some((scan) => scan?.status === "waiting")
