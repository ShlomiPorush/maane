import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  type ActionState,
  type AttachmentView,
  DELIVERY_SOURCES,
  DELIVERY_STATUSES,
  type DeliverySource,
  type DeliveryStatus,
  type FieldNotice,
  type IntakeEntry,
  type IntakeLog,
  type LinkReason,
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
  type StatusFilter,
  statusesOf,
  TEXT_FIELDS,
  type TextField,
  type TicketList,
  type TicketStatus,
  type TicketSummary,
  type TicketView,
  type UnmatchedDelivery,
} from "@maane/shared"
import { and, asc, type Column, desc, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm"
import { alias, QueryBuilder } from "drizzle-orm/pg-core"
import { actionPassed, OPEN_ACTION_STATES } from "../actions/timed.ts"
import { Categories } from "../categories/service.ts"
import type { Db } from "../db/client.ts"
import {
  authUser,
  intakeRecord,
  message,
  messagePart,
  organization,
  outbox,
  outboxRecipient,
  storedFile,
  ticket,
  ticketCategory,
  ticketLink,
  ticketParticipant,
  timedAction,
} from "../db/schema.ts"
import { storedFilePath } from "../files/paths.ts"
import { messageSourceView, ticketSourceView } from "../imports/source.ts"
import { finishedAt } from "../imports/window.ts"
import { linkViews } from "../links/service.ts"
import { type Direction, directBlocks, messageDirection } from "../mail/direction.ts"
import { renderMailHtml } from "../mail/html.ts"
import type { OrganizationScope } from "../organizations/scope.ts"
import { reminderMayGoAgain } from "../reminders/checks.ts"
import { categoriesOf, moveTargets } from "./workflow.ts"

const INLINE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const INLINE_IMAGES_MAX_BYTES = 20 * 1024 * 1024

function unmatchedOf(row: {
  unmatchedDeliveryAt: Date | null
  unmatchedDeliverySource: string | null
  unmatchedDeliveryEvent: unknown
}): UnmatchedDelivery | null {
  if (!row.unmatchedDeliveryAt) return null
  const event = (typeof row.unmatchedDeliveryEvent === "object" ? row.unmatchedDeliveryEvent : null) as Record<
    string,
    unknown
  > | null
  const text = (value: unknown) => (typeof value === "string" ? value : null)
  const status = text(event?.status)
  const source = text(row.unmatchedDeliverySource)
  return {
    source: (DELIVERY_SOURCES as readonly string[]).includes(source ?? "") ? (source as DeliverySource) : "report",
    recordedAt: row.unmatchedDeliveryAt.toISOString(),
    status: (DELIVERY_STATUSES as readonly string[]).includes(status ?? "") ? (status as DeliveryStatus) : null,
    at: text(event?.at),
    recipient: text(event?.recipient),
    messageId: text(event?.messageId),
  }
}

const STORED = new Set<string>(STORED_STATUSES)
const isPartStatus = (value: string): value is PartStatus => (PART_STATUSES as readonly string[]).includes(value)

function inScope(scope: OrganizationScope, column: Column): SQL | undefined {
  if (scope.all) return undefined
  if (scope.organizationIds.length === 0) return sql`false`
  return inArray(column, scope.organizationIds)
}

function encodeCursor(at: string, key: string | number): string {
  return Buffer.from(JSON.stringify([at, key]), "utf8").toString("base64url")
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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

const microseconds = (column: Column) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

export class CursorError extends Error {}

const addressesOf = (value: unknown): MailAddress[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is { address: string; name?: string | null } => typeof item?.address === "string")
        .map((item) => ({ address: item.address, name: typeof item.name === "string" ? item.name : null }))
    : []

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

function bodyLines(text: string | null, html: string | null): number {
  const source = text ?? (html ? html.replace(/<[^>]*>/g, " ") : "")
  let lines = 0
  for (const line of source.split(/\r?\n/)) lines += Math.max(1, Math.ceil(line.length / 90))
  const images = html ? (html.match(/<img\b/gi)?.length ?? 0) : 0
  return Math.min(400, lines + images * 3)
}

export function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

const NUMBER_TERM = /^#?([1-9][0-9]{0,15})$/

export function searchCondition(term: string, scope: OrganizationScope): SQL {
  const pattern = containsPattern(term)
  const digits = NUMBER_TERM.exec(term)?.[1]
  const number = digits !== undefined && Number.isSafeInteger(Number(digits)) ? Number(digits) : null
  const matched = alias(ticket, "matched")
  const byParticipant = alias(ticket, "by_participant")
  const byMessage = alias(ticket, "by_message")
  const query = new QueryBuilder()
  const found = query
    .select({ id: matched.id })
    .from(matched)
    .where(
      and(
        inScope(scope, matched.organizationId),
        or(ilike(matched.subject, pattern), number === null ? undefined : eq(matched.number, number)),
      ),
    )
    .unionAll(
      query
        .select({ id: ticketParticipant.ticketId })
        .from(ticketParticipant)
        .innerJoin(byParticipant, eq(byParticipant.id, ticketParticipant.ticketId))
        .where(
          and(
            inScope(scope, byParticipant.organizationId),
            or(ilike(ticketParticipant.address, pattern), ilike(ticketParticipant.name, pattern)),
          ),
        ),
    )
    .unionAll(
      query
        .select({ id: byMessage.id })
        .from(message)
        .innerJoin(byMessage, eq(byMessage.id, message.ticketId))
        .where(and(inScope(scope, byMessage.organizationId), ilike(message.textBody, pattern))),
    )
  return inArray(ticket.id, found)
}

function snoozedUntil(until: Date | null): string | null {
  return until && until.getTime() > Date.now() ? until.toISOString() : null
}

export interface ListFilters {
  organization?: string
  search?: string
  status: StatusFilter
  category?: string
  flagged?: boolean
  cursor?: string
  limit: number
}

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

  async list(scope: OrganizationScope, filters: ListFilters): Promise<TicketList> {
    const rows = await this.listQuery(scope, filters)

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
        snoozedUntil: snoozedUntil(row.snoozedUntil),
      }
    })
    const last = rows.at(-1)
    return {
      tickets,
      next: rows.length === filters.limit && last ? encodeCursor(last.cursorAt, last.number) : null,
      organizations: await this.organizations(scope),
      categories: await new Categories(this.db).refs(),
    }
  }

  listQuery(scope: OrganizationScope, filters: ListFilters) {
    const cursor = filters.cursor ? decodeCursor(filters.cursor, "number") : null
    if (filters.cursor && !cursor) throw new CursorError()
    const flagged = sql`(cardinality(${ticket.reviewFlags}) > 0 or exists (select 1 from ${message} where ${message.ticketId} = ${ticket.id} and cardinality(${message.reviewFlags}) > 0))`
    const statuses = statusesOf(filters.status)
    const snoozed = sql`(${ticket.snoozedUntil} is not null and ${ticket.snoozedUntil} > now())`
    const conditions = [
      inScope(scope, ticket.organizationId),
      filters.organization ? eq(ticket.organizationId, filters.organization) : undefined,
      statuses ? inArray(ticket.status, [...statuses]) : undefined,
      filters.status === "open_work" ? sql`not ${snoozed}` : filters.status === "snoozed" ? snoozed : undefined,
      filters.category
        ? sql`exists (select 1 from ${ticketCategory} where ${ticketCategory.ticketId} = ${ticket.id} and ${ticketCategory.categoryId} = ${filters.category})`
        : undefined,
      filters.flagged ? flagged : undefined,
      filters.search ? searchCondition(filters.search, scope) : undefined,
      cursor
        ? sql`(${ticket.lastActivityAt}, ${ticket.number}) < (${cursor.at}::timestamptz, ${cursor.key})`
        : undefined,
    ]
    return this.db
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
        snoozedUntil: ticket.snoozedUntil,
        cursorAt: microseconds(ticket.lastActivityAt),
      })
      .from(ticket)
      .innerJoin(organization, eq(organization.id, ticket.organizationId))
      .where(and(...conditions))
      .orderBy(desc(ticket.lastActivityAt), desc(ticket.number))
      .limit(filters.limit)
  }

  async organizations(scope: OrganizationScope): Promise<{ id: string; name: string }[]> {
    return this.db
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .where(inScope(scope, organization.id))
      .orderBy(asc(sql`lower(${organization.name})`))
  }

  async view(
    scope: OrganizationScope,
    number: number,
  ): Promise<(Omit<TicketView, "compose" | "scheduled"> & { ticketId: string; organizationSignature: string }) | null> {
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
          .select({
            messageId: outbox.messageId,
            state: outbox.state,
            problem: outbox.problem,
            unmatchedDeliveryAt: outbox.unmatchedDeliveryAt,
            unmatchedDeliverySource: outbox.unmatchedDeliverySource,
            unmatchedDeliveryEvent: outbox.unmatchedDeliveryEvent,
            actionId: outbox.actionId,
            actionVersion: outbox.actionVersion,
            actionKind: timedAction.kind,
            actionState: timedAction.state,
            actionCurrent: timedAction.version,
          })
          .from(outbox)
          .leftJoin(timedAction, eq(timedAction.id, outbox.actionId))
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

    const earliest = (dates: (Date | null)[]) =>
      dates.reduce<Date | null>((first, date) => (date && (first === null || date < first) ? date : first), null)
    const sentAt = (id: string) => {
      const own = recipients.filter((r) => r.messageId === id)
      return (
        earliest(own.map((r) => r.firstDeliveredAt)) ??
        earliest(own.filter((r) => r.state === "accepted" && r.markedBy === null).map((r) => r.acceptedAt))
      )
    }
    const clicked = await linkViews(
      this.db,
      replyIds.map((id) => ({ id, since: sentAt(id) })),
    )
    const authorOf = new Map(authors.map((a) => [a.id, { id: a.id, name: a.name || a.username || a.id }]))
    const reminderResend = new Set<string>()
    for (const sent of outboxes)
      if (
        sent.actionKind === "reminder" &&
        sent.actionId !== null &&
        sent.actionState !== null &&
        sent.actionCurrent !== null &&
        (await reminderMayGoAgain(
          this.db,
          sent,
          { id: sent.actionId, state: sent.actionState, version: sent.actionCurrent },
          { id: t.id, status: t.status as TicketStatus },
        ))
      )
        reminderResend.add(sent.messageId)
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
            delivery: (DELIVERY_STATUSES as readonly string[]).includes(r.delivery ?? "")
              ? (r.delivery as DeliveryStatus)
              : null,
            deliveryAt: r.deliveryAt?.toISOString() ?? null,
            deliveryDetail: r.deliveryDetail,
          })),
        unmatchedDelivery: unmatchedOf(sent),
        scheduledEnded:
          sent.actionKind === "reply" &&
          !actionPassed(
            sent.actionState === null || sent.actionCurrent === null
              ? null
              : { state: sent.actionState, version: sent.actionCurrent },
            sent.actionVersion,
          ),
        reminder: sent.actionKind === "reminder",
        reminderResend: reminderResend.has(id),
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
        links: clicked.get(m.id) ?? [],
        scheduled: outboxes.some((o) => o.messageId === m.id && o.actionKind === "reply"),
        reminder: outboxes.some((o) => o.messageId === m.id && o.actionKind === "reminder"),
        imported: m.zendeskKey !== null ? messageSourceView(m.zendesk) : null,
      }
    })
    const [pending] = await this.db
      .select({ id: timedAction.id, dueAt: timedAction.dueAt, state: timedAction.state })
      .from(timedAction)
      .where(
        and(
          eq(timedAction.ticketId, t.id),
          eq(timedAction.kind, "reminder"),
          inArray(timedAction.state, [...OPEN_ACTION_STATES]),
        ),
      )
      .orderBy(desc(timedAction.createdAt))
      .limit(1)

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
        categories: await categoriesOf(this.db, t.id),
        snoozedUntil: snoozedUntil(t.snoozedUntil),
        snoozeOverdue: t.snoozedUntil !== null && t.snoozedUntil.getTime() <= Date.now(),
        imported:
          t.zendeskId !== null ? ticketSourceView(t.zendeskId, t.zendesk, (await finishedAt(this.db)) === null) : null,
      },
      participants,
      links: links.map((link) => ({ number: link.number, reason: link.reason as LinkReason })),
      categories: await new Categories(this.db).refs(),
      moveTargets: await moveTargets(this.db, scope, t.organizationId),
      messages: views,
      reminder: pending
        ? { id: pending.id, dueAt: pending.dueAt.toISOString(), state: pending.state as ActionState }
        : null,
      ticketId: t.id,
      organizationSignature: row.signature,
    }
  }

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
    const dir = messageDirection(text, row.htmlBody, "ltr")
    const directed = directBlocks(row.htmlBody, dir)
    const rendered = renderMailHtml(directed, { remoteImages, inline: (id) => urls.get(id) ?? null })
    return { kind: "html", html: rendered.html, dir }
  }

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

  async intake(filters: { flagged?: boolean; cursor?: string; limit: number }): Promise<IntakeLog> {
    const cursor = filters.cursor ? decodeCursor(filters.cursor, "uuid") : null
    if (filters.cursor && !cursor) throw new CursorError()
    const opened = alias(ticket, "opened")
    const matched = alias(ticket, "matched")
    const flags = sql<
      string[]
    >`array(select distinct unnest(${message.reviewFlags} || coalesce(${opened.reviewFlags}, '{}'::text[])) order by 1)`
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
      .where(
        and(
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
