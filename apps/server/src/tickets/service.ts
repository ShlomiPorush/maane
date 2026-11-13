// What agents read of tickets (plan 2.4): the list, one ticket with its messages and files, a message's body, and a
// file. Every query takes the result of visibleOrganizations, read on each request, and a ticket, message, or file
// outside it reads as not found. A file is reached only through its attachment, its message, and its ticket, never by
// its hash, so the same content in two organizations leaks nothing across them. The intake log is for admins and reads
// every record.

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  type AttachmentView,
  type FieldNotice,
  type IntakeEntry,
  type IntakeLog,
  type MailAddress,
  type MessageDirection,
  type MessageView,
  type OutboxState,
  PART_STATUSES,
  type PartStatus,
  type Provider,
  previewKind,
  type RecipientState,
  type SendProblem,
  STORED_STATUSES,
  TEXT_FIELDS,
  type TextField,
  type TicketList,
  type TicketStatus,
  type TicketSummary,
  type TicketView,
} from "@maane/shared"
import { and, asc, type Column, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import type { Db } from "../db/client.ts"
import {
  authUser,
  intakeConversation,
  intakeRecord,
  message,
  messagePart,
  organization,
  outbox,
  outboxRecipient,
  storedFile,
  ticket,
  ticketLink,
  ticketParticipant,
} from "../db/schema.ts"
import { storedFilePath } from "../files/paths.ts"
import { type Direction, directBlocks, messageDirection } from "../mail/direction.ts"
import { renderMailHtml } from "../mail/html.ts"
import type { OrganizationScope } from "../organizations/scope.ts"

/** The image types an inline part may be embedded as, by the type read from its content. */
const INLINE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
/** Inline images are embedded up to these sizes; a larger one stays a file to download. */
export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const INLINE_IMAGES_MAX_BYTES = 20 * 1024 * 1024

const STORED = new Set<string>(STORED_STATUSES)
const isPartStatus = (value: string): value is PartStatus => (PART_STATUSES as readonly string[]).includes(value)

/** The scope as a condition on an organization column: every row, the listed organizations, or none. */
function inScope(scope: OrganizationScope, column: Column): SQL | undefined {
  if (scope.all) return undefined
  if (scope.organizationIds.length === 0) return sql`false`
  return inArray(column, scope.organizationIds)
}

/** A keyset cursor: an instant written by PostgreSQL to the microsecond, and a tie breaker. */
function encodeCursor(at: string, key: string | number): string {
  return Buffer.from(JSON.stringify([at, key]), "utf8").toString("base64url")
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A cursor this service made, or null when the text is not one. */
function decodeCursor<K extends "number" | "uuid">(
  text: string,
  kind: K,
): { at: string; key: K extends "number" ? number : string } | null {
  try {
    const value = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as unknown
    if (!Array.isArray(value) || value.length !== 2) return null
    const [at, key] = value as [unknown, unknown]
    if (typeof at !== "string" || !CURSOR_AT.test(at)) return null
    if (kind === "number" && (typeof key !== "number" || !Number.isSafeInteger(key) || key < 1)) return null
    if (kind === "uuid" && (typeof key !== "string" || !UUID.test(key))) return null
    return { at, key: key as K extends "number" ? number : string }
  } catch {
    return null
  }
}

/** An instant as UTC text to the microsecond, for a cursor that compares exactly with the column. */
const microseconds = (column: Column) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

export class CursorError extends Error {}

const addressesOf = (value: unknown): MailAddress[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is { address: string; name?: string | null } => typeof item?.address === "string")
        .map((item) => ({ address: item.address, name: typeof item.name === "string" ? item.name : null }))
    : []

/** The field scans that kept a text field from being stored as received. */
function fieldNotices(scans: unknown): FieldNotice[] {
  if (typeof scans !== "object" || scans === null) return []
  const notices: FieldNotice[] = []
  for (const field of TEXT_FIELDS) {
    const scan = (scans as Record<string, { status?: unknown; signature?: unknown }>)[field]
    if (!scan || typeof scan.status !== "string" || !isPartStatus(scan.status)) continue
    if (scan.status === "clean") continue
    notices.push({
      field: field as TextField,
      status: scan.status,
      signature: typeof scan.signature === "string" ? scan.signature : null,
    })
  }
  return notices
}

/** A message's subject as stored, or Graph's while its header block may be shown (it is null otherwise). */
function subjectOf(row: { subject: string | null; graph: unknown }): string | null {
  if (row.subject !== null) return row.subject
  const graph = row.graph as { subject?: unknown } | null
  return typeof graph?.subject === "string" ? graph.subject : null
}

function senderOf(row: { fromAddress: string | null; fromName: string | null; graph: unknown }): MailAddress | null {
  if (row.fromAddress) return { address: row.fromAddress, name: row.fromName }
  const graph = row.graph as { from?: { address?: unknown; name?: unknown } | null } | null
  const address = graph?.from?.address
  if (typeof address !== "string" || address === "") return null
  return { address: address.toLowerCase(), name: typeof graph?.from?.name === "string" ? graph.from.name : null }
}

/**
 * What the body document is made of: the stored text and HTML, their field scans, and the scan state of the parts an
 * HTML body can show inline. It changes when a waiting field or image is decided, so the frame loads the new document.
 */
function bodyVersion(
  m: { textBody: string | null; htmlBody: string | null; fieldScans: unknown },
  inline: { part: { id: string; status: string; storedSha256: string | null }; storedStatus: string | null }[],
): string {
  const hash = createHash("sha256")
  hash.update(JSON.stringify([m.textBody, m.htmlBody, m.fieldScans]))
  for (const { part, storedStatus } of inline)
    hash.update(JSON.stringify([part.id, part.status, part.storedSha256, storedStatus]))
  return hash.digest("hex").slice(0, 16)
}

/** About how many lines a body takes at a usual width: its text wrapped at 90 characters, and room for images. */
function bodyLines(text: string | null, html: string | null): number {
  const source = text ?? (html ? html.replace(/<[^>]*>/g, " ") : "")
  let lines = 0
  for (const line of source.split(/\r?\n/)) lines += Math.max(1, Math.ceil(line.length / 90))
  // Only an estimate of the frame height: the HTML itself is never rewritten by a pattern.
  const images = html ? (html.match(/<img\b/gi)?.length ?? 0) : 0
  return Math.min(400, lines + images * 3)
}

export interface ListFilters {
  organization?: string
  status?: TicketStatus
  flagged?: boolean
  cursor?: string
  limit: number
}

/** A file the user may reach: the part, and the stored file when there is one. */
export interface FileAccess {
  fileName: string | null
  status: PartStatus
  storedSha256: string | null
  detectedType: string | null
  storedStatus: string | null
  size: number
}

export class Tickets {
  constructor(
    private readonly db: Db,
    private readonly filesDir: string,
  ) {}

  /** The ticket list: newest activity first, by a cursor after the last row shown. */
  async list(scope: OrganizationScope, filters: ListFilters): Promise<TicketList> {
    const cursor = filters.cursor ? decodeCursor(filters.cursor, "number") : null
    if (filters.cursor && !cursor) throw new CursorError()
    const flagged = sql`(cardinality(${ticket.reviewFlags}) > 0 or exists (select 1 from ${message} where ${message.ticketId} = ${ticket.id} and cardinality(${message.reviewFlags}) > 0))`
    const conditions = [
      inScope(scope, ticket.organizationId),
      filters.organization ? eq(ticket.organizationId, filters.organization) : undefined,
      filters.status ? eq(ticket.status, filters.status) : undefined,
      filters.flagged ? flagged : undefined,
      cursor
        ? sql`(${ticket.lastActivityAt}, ${ticket.number}) < (${cursor.at}::timestamptz, ${cursor.key})`
        : undefined,
    ]
    const rows = await this.db
      .select({
        id: ticket.id,
        number: ticket.number,
        subject: ticket.subject,
        status: ticket.status,
        reviewFlags: ticket.reviewFlags,
        organizationId: organization.id,
        organizationName: organization.name,
        createdAt: ticket.createdAt,
        lastActivityAt: ticket.lastActivityAt,
        cursorAt: microseconds(ticket.lastActivityAt),
      })
      .from(ticket)
      .innerJoin(organization, eq(organization.id, ticket.organizationId))
      .where(and(...conditions))
      .orderBy(desc(ticket.lastActivityAt), desc(ticket.number))
      .limit(filters.limit)

    const ids = rows.map((row) => row.id)
    const firsts = ids.length
      ? await this.db
          .selectDistinctOn([message.ticketId], {
            ticketId: message.ticketId,
            fromAddress: message.fromAddress,
            fromName: message.fromName,
            graph: message.graph,
          })
          .from(message)
          .where(inArray(message.ticketId, ids))
          .orderBy(message.ticketId, asc(message.receivedAt), asc(message.createdAt))
      : []
    // Every message of these tickets, for the count and the review flags a ticket's messages carry.
    const messageRows = ids.length
      ? await this.db
          .select({ ticketId: message.ticketId, reviewFlags: message.reviewFlags })
          .from(message)
          .where(inArray(message.ticketId, ids))
      : []
    const first = new Map(firsts.map((row) => [row.ticketId, row]))
    const count = new Map<string, { count: number; flags: Set<string> }>()
    for (const row of messageRows) {
      if (row.ticketId === null) continue
      const entry = count.get(row.ticketId) ?? { count: 0, flags: new Set<string>() }
      entry.count++
      for (const flag of row.reviewFlags) entry.flags.add(flag)
      count.set(row.ticketId, entry)
    }

    const tickets: TicketSummary[] = rows.map((row) => {
      const sender = first.get(row.id)
      const messages = count.get(row.id)
      return {
        number: row.number,
        subject: row.subject,
        status: row.status as TicketStatus,
        reviewFlags: [...new Set([...row.reviewFlags, ...(messages?.flags ?? [])])].sort(),
        organization: { id: row.organizationId, name: row.organizationName },
        customer: sender ? senderOf(sender) : null,
        messages: messages?.count ?? 0,
        createdAt: row.createdAt.toISOString(),
        lastActivityAt: row.lastActivityAt.toISOString(),
      }
    })
    const last = rows.at(-1)
    return {
      tickets,
      next: rows.length === filters.limit && last ? encodeCursor(last.cursorAt, last.number) : null,
      organizations: await this.organizations(scope),
    }
  }

  /** The organizations a user may see, by name. */
  async organizations(scope: OrganizationScope): Promise<{ id: string; name: string }[]> {
    return this.db
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .where(inScope(scope, organization.id))
      .orderBy(asc(sql`lower(${organization.name})`))
  }

  /**
   * One ticket by its number, with its messages, files, participants, and links; null outside the scope. The route adds
   * what the composer starts from.
   */
  async view(
    scope: OrganizationScope,
    number: number,
  ): Promise<(Omit<TicketView, "compose"> & { ticketId: string; organizationSignature: string }) | null> {
    const [row] = await this.db
      .select({ ticket, organizationName: organization.name, signature: organization.signature })
      .from(ticket)
      .innerJoin(organization, eq(organization.id, ticket.organizationId))
      .where(and(eq(ticket.number, number), inScope(scope, ticket.organizationId)))
    if (!row) return null
    const t = row.ticket

    const messages = await this.db
      .select()
      .from(message)
      .where(eq(message.ticketId, t.id))
      .orderBy(asc(message.receivedAt), asc(message.createdAt))
    const parts = messages.length
      ? await this.db
          .select({ part: messagePart, detectedType: storedFile.detectedType, storedStatus: storedFile.scanStatus })
          .from(messagePart)
          .leftJoin(storedFile, eq(storedFile.sha256, messagePart.storedSha256))
          .where(
            inArray(
              messagePart.messageId,
              messages.map((m) => m.id),
            ),
          )
          .orderBy(asc(messagePart.index))
      : []
    const participants = await this.db
      .select({ address: ticketParticipant.address, name: ticketParticipant.name })
      .from(ticketParticipant)
      .where(eq(ticketParticipant.ticketId, t.id))
      .orderBy(asc(ticketParticipant.createdAt), asc(ticketParticipant.address))
    // Replies and notes: their authors' display names, and where each reply's sending is, per recipient.
    const authorIds = [...new Set(messages.flatMap((m) => (m.authorUserId ? [m.authorUserId] : [])))]
    const authors = authorIds.length
      ? await this.db
          .select({ id: authUser.id, name: authUser.name, username: authUser.username })
          .from(authUser)
          .where(inArray(authUser.id, authorIds))
      : []
    const replyIds = messages.filter((m) => m.direction === "out").map((m) => m.id)
    const outboxes = replyIds.length
      ? await this.db
          .select({ messageId: outbox.messageId, state: outbox.state, problem: outbox.problem })
          .from(outbox)
          .where(inArray(outbox.messageId, replyIds))
      : []
    const recipients = replyIds.length
      ? await this.db
          .select()
          .from(outboxRecipient)
          .where(inArray(outboxRecipient.messageId, replyIds))
          .orderBy(asc(outboxRecipient.position))
      : []
    const other = alias(ticket, "other")
    const links = await this.db
      .select({ number: other.number, reason: ticketLink.reason })
      .from(ticketLink)
      .innerJoin(
        other,
        or(
          and(eq(ticketLink.ticketId, t.id), eq(other.id, ticketLink.linkedTicketId)),
          and(eq(ticketLink.linkedTicketId, t.id), eq(other.id, ticketLink.ticketId)),
        ),
      )
      .where(
        and(
          or(eq(ticketLink.ticketId, t.id), eq(ticketLink.linkedTicketId, t.id)),
          inScope(scope, other.organizationId),
        ),
      )
      .orderBy(asc(other.number))

    const authorOf = new Map(authors.map((a) => [a.id, { id: a.id, name: a.name || a.username || a.id }]))
    const deliveryOf = (id: string): MessageView["delivery"] => {
      const sent = outboxes.find((o) => o.messageId === id)
      if (!sent) return null
      return {
        state: sent.state as OutboxState,
        problem: sent.problem as SendProblem | null,
        recipients: recipients
          .filter((r) => r.messageId === id)
          .map((r) => ({
            address: r.address,
            name: r.name,
            kind: r.kind === "cc" ? "cc" : "to",
            state: r.state as RecipientState,
            provider: r.provider as Provider | null,
            marked: r.markedBy !== null,
          })),
      }
    }
    const views: MessageView[] = messages.map((m) => {
      const attachments: AttachmentView[] = parts
        .filter(({ part }) => part.messageId === m.id)
        .map(({ part, detectedType, storedStatus }) => {
          const status = isPartStatus(part.status) ? part.status : "unavailable"
          const stored = part.storedSha256 !== null && storedStatus !== null && STORED.has(status)
          return {
            id: part.id,
            kind: part.kind === "inline" ? "inline" : "attachment",
            fileName: part.fileName,
            size: part.size,
            status,
            signature: part.signature,
            blockedBy: part.blockedBy,
            unavailableReason: part.unavailableReason,
            detectedType: stored ? detectedType : null,
            // The part and the stored file both say clean.
            preview: stored && storedStatus === "clean" ? previewKind(status, detectedType) : null,
            download: stored,
          }
        })
      const html = m.htmlBody !== null && m.htmlBody !== "" ? m.htmlBody : null
      const text = m.textBody !== null && m.textBody !== "" ? m.textBody : null
      return {
        id: m.id,
        direction: m.direction as MessageDirection,
        author: m.authorUserId ? (authorOf.get(m.authorUserId) ?? null) : null,
        delivery: m.direction === "out" ? deliveryOf(m.id) : null,
        receivedAt: m.receivedAt.toISOString(),
        sentAt: m.sentAt?.toISOString() ?? null,
        from: senderOf(m),
        to: addressesOf(m.toAddresses),
        cc: addressesOf(m.ccAddresses),
        subject: subjectOf(m),
        content: m.content as MessageView["content"],
        reviewFlags: m.reviewFlags,
        body: html ? "html" : text ? "text" : null,
        remoteImages: html ? renderMailHtml(html, { remoteImages: false, inline: () => null }).remoteImages : 0,
        bodyLines: bodyLines(text, html),
        bodyVersion: bodyVersion(
          m,
          parts.filter(({ part }) => part.messageId === m.id && part.contentId !== null),
        ),
        fields: fieldNotices(m.fieldScans),
        attachments,
      }
    })

    return {
      ticket: {
        number: t.number,
        referenceCode: t.referenceCode,
        subject: t.subject,
        status: t.status as TicketStatus,
        reviewFlags: t.reviewFlags,
        organization: { id: t.organizationId, name: row.organizationName },
        supportAddress: t.supportAddress,
        createdAt: t.createdAt.toISOString(),
        lastActivityAt: t.lastActivityAt.toISOString(),
      },
      participants,
      links,
      messages: views,
      ticketId: t.id,
      organizationSignature: row.signature,
    }
  }

  /** A message of a ticket in the scope, with what its body needs; null outside the scope or without a ticket. */
  async body(
    scope: OrganizationScope,
    messageId: string,
    remoteImages: boolean,
  ): Promise<{ kind: "html"; html: string; dir: Direction } | { kind: "text"; text: string } | null> {
    if (!UUID.test(messageId)) return null
    const [row] = await this.db
      .select({ htmlBody: message.htmlBody, textBody: message.textBody })
      .from(message)
      .innerJoin(ticket, eq(ticket.id, message.ticketId))
      .where(and(eq(message.id, messageId), inScope(scope, ticket.organizationId)))
    if (!row) return null
    const text = row.textBody !== null && row.textBody !== "" ? row.textBody : null
    if (row.htmlBody === null || row.htmlBody === "") return text === null ? null : { kind: "text", text }

    // The inline images this message may show: its own parts that scanned clean, stored as clean, with an image type.
    const inline = await this.db
      .select({ contentId: messagePart.contentId, sha256: storedFile.sha256, detectedType: storedFile.detectedType })
      .from(messagePart)
      .innerJoin(storedFile, eq(storedFile.sha256, messagePart.storedSha256))
      .where(
        and(
          eq(messagePart.messageId, messageId),
          eq(messagePart.status, "clean"),
          eq(storedFile.scanStatus, "clean"),
          inArray(storedFile.detectedType, [...INLINE_IMAGE_TYPES]),
          sql`${messagePart.contentId} is not null`,
          sql`${storedFile.size} <= ${INLINE_IMAGE_MAX_BYTES}`,
        ),
      )
      .orderBy(asc(messagePart.index))
    const urls = new Map<string, string>()
    let total = 0
    for (const part of inline) {
      if (!part.contentId || urls.has(part.contentId)) continue
      const bytes = await readFile(storedFilePath(this.filesDir, part.sha256)).catch(() => null)
      if (!bytes || total + bytes.length > INLINE_IMAGES_MAX_BYTES) continue
      total += bytes.length
      urls.set(part.contentId, `data:${part.detectedType};base64,${bytes.toString("base64")}`)
    }
    // The direction of each paragraph first, then the allow list once more, last.
    const dir = messageDirection(text, row.htmlBody, "ltr")
    const directed = directBlocks(row.htmlBody, dir)
    const rendered = renderMailHtml(directed, { remoteImages, inline: (id) => urls.get(id) ?? null })
    return { kind: "html", html: rendered.html, dir }
  }

  /** An attachment or inline part of a ticket's message in the scope, or null. */
  async file(scope: OrganizationScope, partId: string): Promise<FileAccess | null> {
    if (!UUID.test(partId)) return null
    const [row] = await this.db
      .select({
        fileName: messagePart.fileName,
        status: messagePart.status,
        storedSha256: messagePart.storedSha256,
        size: messagePart.size,
        detectedType: storedFile.detectedType,
        storedStatus: storedFile.scanStatus,
      })
      .from(messagePart)
      .innerJoin(message, eq(message.id, messagePart.messageId))
      .innerJoin(ticket, eq(ticket.id, message.ticketId))
      .leftJoin(storedFile, eq(storedFile.sha256, messagePart.storedSha256))
      .where(and(eq(messagePart.id, partId), inScope(scope, ticket.organizationId)))
    if (!row) return null
    return { ...row, status: isPartStatus(row.status) ? row.status : "unavailable" }
  }

  storedPath(sha256: string): string {
    return storedFilePath(this.filesDir, sha256)
  }

  /** The intake log (admins): every record, newest first, with the review flags of its message and thread. */
  async intake(filters: {
    mode?: "listening" | "live"
    flagged?: boolean
    cursor?: string
    limit: number
  }): Promise<IntakeLog> {
    const cursor = filters.cursor ? decodeCursor(filters.cursor, "uuid") : null
    if (filters.cursor && !cursor) throw new CursorError()
    const opened = alias(ticket, "opened")
    const matched = alias(ticket, "matched")
    const flags = sql<
      string[]
    >`array(select distinct unnest(${message.reviewFlags} || coalesce(${opened.reviewFlags}, '{}'::text[]) || coalesce(${intakeConversation.reviewFlags}, '{}'::text[])) order by 1)`
    const rows = await this.db
      .select({
        record: intakeRecord,
        receivedAt: message.receivedAt,
        subject: message.subject,
        fromAddress: message.fromAddress,
        fromName: message.fromName,
        graph: message.graph,
        organizationName: organization.name,
        ticket: opened.number,
        matchedTicket: matched.number,
        flags,
        cursorAt: microseconds(intakeRecord.createdAt),
      })
      .from(intakeRecord)
      .innerJoin(message, eq(message.id, intakeRecord.messageId))
      .leftJoin(organization, eq(organization.id, intakeRecord.organizationId))
      .leftJoin(opened, eq(opened.id, intakeRecord.ticketId))
      .leftJoin(matched, eq(matched.id, intakeRecord.matchedTicketId))
      .leftJoin(intakeConversation, eq(intakeConversation.id, intakeRecord.conversationId))
      .where(
        and(
          filters.mode ? eq(intakeRecord.mode, filters.mode) : undefined,
          filters.flagged ? sql`cardinality(${flags}) > 0` : undefined,
          cursor
            ? sql`(${intakeRecord.createdAt}, ${intakeRecord.messageId}) < (${cursor.at}::timestamptz, ${cursor.key}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(intakeRecord.createdAt), desc(intakeRecord.messageId))
      .limit(filters.limit)
    const entries: IntakeEntry[] = rows.map((row) => ({
      messageId: row.record.messageId,
      at: row.record.createdAt.toISOString(),
      receivedAt: row.receivedAt.toISOString(),
      mode: row.record.mode === "live" ? "live" : "listening",
      outcome: row.record.outcome as IntakeEntry["outcome"],
      classification: row.record.classification,
      reasons: (row.record.reason ?? "")
        .split(",")
        .map((code) => code.trim())
        .filter(Boolean),
      matchLayer: row.record.matchLayer as IntakeEntry["matchLayer"],
      subject: subjectOf(row),
      from: senderOf(row),
      supportAddress: row.record.supportAddress,
      organization:
        row.record.organizationId && row.organizationName
          ? { id: row.record.organizationId, name: row.organizationName }
          : null,
      ticket: row.ticket,
      matchedTicket: row.matchedTicket,
      flags: row.flags,
    }))
    const last = rows.at(-1)
    return {
      entries,
      next: rows.length === filters.limit && last ? encodeCursor(last.cursorAt, last.record.messageId) : null,
    }
  }
}
