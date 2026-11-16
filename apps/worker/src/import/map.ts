// How a Zendesk record becomes Maane's rows (plan 5.1), without the database: the status, the participants, the
// followers, the custom fields, the links, and each comment and side conversation message as a planned message. The
// field paths follow Zendesk's API reference (Tickets, Ticket Comments, the Via object, Users, Ticket Fields, Side
// Conversations); a field that is missing or of another shape reads as absent.

import type { EmailIdentifiers, ImportedMessageSource, ImportedTicketSource } from "@maane/server/imports/source"
import { type MailAddress, parseExactAddress, type TicketStatus } from "@maane/shared"
import type {
  Manifest,
  ZendeskAudit,
  ZendeskFullComment,
  ZendeskSideConversation,
  ZendeskTicketRecord,
  ZendeskUser,
  ZendeskVia,
} from "@maane/zendesk"

/** Zendesk's statuses map 1:1 (requirements 3.1); `hold` is Maane's `on_hold`. */
const STATUSES: Record<string, TicketStatus> = {
  new: "new",
  open: "open",
  pending: "pending",
  hold: "on_hold",
  on_hold: "on_hold",
  solved: "solved",
  closed: "closed",
}

/** The Maane status of a Zendesk status; an unknown one reads as open. */
export const statusOf = (status: string | null | undefined): TicketStatus => STATUSES[status ?? ""] ?? "open"

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)
const id = (value: unknown): string | null =>
  typeof value === "number" || (typeof value === "string" && /^\d{1,20}$/.test(value)) ? String(value) : null
const ids = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap((item) => id(item) ?? []) : [])

/** An address as Maane keeps it (lower case), or null when it is not one plain address. */
export function addressOf(value: unknown): string | null {
  const raw = text(value)
  if (raw === null) return null
  const parsed = parseExactAddress(raw.trim())
  return parsed.ok ? parsed.value : null
}

/** The requester first, then every CC (Zendesk's email CCs and older collaborators), each once, with an address. */
export function participantsOf(record: ZendeskTicketRecord, users: Map<string, ZendeskUser>): MailAddress[] {
  const people: MailAddress[] = []
  const seen = new Set<string>()
  const requester = id(record.requester_id)
  for (const userId of [
    ...(requester ? [requester] : []),
    ...ids(record.email_cc_ids),
    ...ids(record.collaborator_ids),
  ]) {
    const user = users.get(userId)
    const address = addressOf(user?.email)
    if (!address || seen.has(address)) continue
    seen.add(address)
    people.push({ address, name: text(user?.name) })
  }
  return people
}

/** Followers as source information only, never recipients. */
export function followersOf(record: ZendeskTicketRecord, users: Map<string, ZendeskUser>) {
  return ids(record.follower_ids).map((userId) => {
    const user = users.get(userId)
    return { name: text(user?.name), address: addressOf(user?.email) }
  })
}

export interface FieldDefinition {
  title: string
  /** A drop-down's options: their values (tags) to their names. */
  options: Map<string, string>
}

/** The ticket fields by ID, from the `ticket_fields` collection. */
export function fieldDefinitions(records: Record<string, unknown>[]): Map<string, FieldDefinition> {
  const definitions = new Map<string, FieldDefinition>()
  for (const record of records) {
    const fieldId = id(record.id)
    const title = text(record.title) ?? text(record.raw_title)
    if (!fieldId || !title) continue
    const options = new Map<string, string>()
    for (const option of Array.isArray(record.custom_field_options) ? record.custom_field_options : []) {
      const value = text((option as Record<string, unknown>)?.value)
      const name = text((option as Record<string, unknown>)?.name)
      if (value && name) options.set(value, name)
    }
    definitions.set(fieldId, { title, options })
  }
  return definitions
}

/** The custom fields that have a value, by the field's name; a drop-down's value by its option's name. */
export function fieldsOf(record: ZendeskTicketRecord, definitions: Map<string, FieldDefinition>) {
  const fields: { name: string; value: string }[] = []
  for (const field of Array.isArray(record.custom_fields) ? record.custom_fields : []) {
    const entry = field as { id?: unknown; value?: unknown }
    const fieldId = id(entry?.id)
    const definition = fieldId ? definitions.get(fieldId) : undefined
    const values = (Array.isArray(entry?.value) ? entry.value : [entry?.value]).flatMap((value) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? [String(value)] : [],
    )
    const shown = values.filter((value) => value !== "").map((value) => definition?.options.get(value) ?? value)
    if (shown.length === 0) continue
    fields.push({ name: definition?.title ?? `#${fieldId ?? "?"}`, value: shown.join(", ") })
  }
  return fields
}

/** The tags of a ticket, as Zendesk kept them. */
export const tagsOf = (record: ZendeskTicketRecord): string[] =>
  Array.isArray(record.tags) ? [...new Set(record.tags.filter((tag): tag is string => typeof tag === "string"))] : []

/** The ticket a via object names as merged or followed up (`source.rel`, with `source.from.ticket_id`). */
function viaLinks(via: ZendeskVia | null | undefined): ImportedTicketSource["links"] {
  const rel = via?.source?.rel
  if (rel !== "merge" && rel !== "follow_up") return []
  const reason = rel === "merge" ? "merged" : "follow_up"
  const from = via?.source?.from
  return [...ids([from?.ticket_id]), ...ids(from?.ticket_ids)].map((zendeskId) => ({
    zendeskId: Number(zendeskId),
    reason,
  }))
}

/**
 * The tickets this one names: a follow-up's original and the follow-ups it lists (`followup_ids`), and the tickets
 * merged into it, by the via of the ticket and of its audits.
 */
export function linksOf(record: ZendeskTicketRecord, audits: ZendeskAudit[]): ImportedTicketSource["links"] {
  const links = [
    ...viaLinks(record.via),
    ...audits.flatMap((audit) => viaLinks(audit.via)),
    ...ids(record.followup_ids).map((zendeskId) => ({ zendeskId: Number(zendeskId), reason: "follow_up" as const })),
  ]
  const self = Number(record.id)
  const seen = new Set<string>()
  return links.filter((link) => {
    const key = `${link.zendeskId}:${link.reason}`
    if (link.zendeskId === self || !Number.isSafeInteger(link.zendeskId) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** A message the import writes, before its text is scanned. */
export interface PlannedMessage {
  key: string
  direction: "in" | "out" | "note"
  at: Date
  from: MailAddress | null
  to: MailAddress[]
  cc: MailAddress[]
  text: string | null
  html: string | null
  /** The header block's values: the names and the subject the message shows. */
  headers: string[]
  source: ImportedMessageSource
}

const dateOf = (value: unknown, fallback: Date): Date => {
  const parsed = typeof value === "string" ? new Date(value) : null
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap((item) => (typeof item === "string" ? [item] : [])) : []

/**
 * A comment's via objects, in the order the import reads them: `metadata.via` (where Zendesk's example response of
 * the comments keeps it), then the comment's own `via` (the field the reference lists). Each value is taken from the
 * first one that has it.
 */
const viasOf = (comment: ZendeskFullComment): ZendeskVia[] =>
  [comment.metadata?.via, comment.via].filter((via): via is ZendeskVia => typeof via === "object" && via !== null)

/** The first value `pick` finds in the via objects, else null. */
function first<T>(vias: ZendeskVia[], pick: (via: ZendeskVia) => T | null): T | null {
  for (const via of vias) {
    const value = pick(via)
    if (value !== null) return value
  }
  return null
}

/** The first non-empty list `pick` finds in the via objects, else none. */
function firstList<T>(vias: ZendeskVia[], pick: (via: ZendeskVia) => T[]): T[] {
  for (const via of vias) {
    const value = pick(via)
    if (value.length > 0) return value
  }
  return []
}

/**
 * The email identifiers Zendesk recorded for a comment: its Message-ID (`metadata.system.message_id`, not in Zendesk's
 * reference, read when present), the original sender and recipients of its via objects (`metadata.via` first, then
 * `via`); or the mark that neither recorded any.
 */
export function emailOf(comment: ZendeskFullComment): EmailIdentifiers {
  const system = (comment.metadata?.system ?? {}) as Record<string, unknown>
  const rawId = text(system.message_id)
  const messageId = rawId ? rawId.replace(/^<|>$/g, "").slice(0, 998) : null
  const vias = viasOf(comment)
  const original = firstList(vias, (via) =>
    strings(via.source?.from?.original_recipients).flatMap((value) => addressOf(value) ?? []),
  )
  const cc = firstList(vias, (via) => strings(via.source?.to?.email_ccs).flatMap((value) => addressOf(value) ?? []))
  const fromAddress = first(vias, (via) => addressOf(via.source?.from?.address))
  const fromName = first(vias, (via) => text(via.source?.from?.name))
  const toAddress = first(vias, (via) => addressOf(via.source?.to?.address))
  const toName = first(vias, (via) => text(via.source?.to?.name))
  if (!messageId && !fromAddress && !toAddress && original.length === 0 && cc.length === 0) return { kind: "none" }
  return {
    kind: "recorded",
    messageId,
    from: fromAddress || fromName ? { address: fromAddress, name: fromName } : null,
    to: toAddress || toName ? { address: toAddress, name: toName } : null,
    cc,
    originalRecipients: original,
  }
}

/** The channel a comment came by: `metadata.via` first, then `via`. */
function channelOf(comment: ZendeskFullComment): string | null {
  return first(viasOf(comment), (via) =>
    typeof via.channel === "string" || typeof via.channel === "number" ? String(via.channel) : null,
  )
}

/** Whether a Zendesk user is one of its agents (an agent or an admin). */
const isAgent = (user: ZendeskUser | undefined) => user?.role === "agent" || user?.role === "admin"

export interface FileFacts {
  files: ImportedMessageSource["files"]
  failed: { id: string; name: string | null }[]
}

/** A comment's files as the manifest records them: imported by plan 5.2, counted and reported here. */
export function filesOf(attachments: unknown, manifest: Manifest): FileFacts {
  const files: ImportedMessageSource["files"] = []
  const failed: FileFacts["failed"] = []
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const entry = attachment as { id?: unknown; file_name?: unknown; name?: unknown; inline?: unknown }
    const fileId = id(entry?.id)
    if (!fileId) continue
    const name = text(entry.file_name) ?? text(entry.name)
    const recorded = manifest.files[fileId]
    const status = recorded?.status === "ok" ? "ok" : recorded ? "failed" : "missing"
    files.push({ id: fileId, name, inline: entry.inline === true, status })
    if (status !== "ok") failed.push({ id: fileId, name })
  }
  return { files, failed }
}

/**
 * A comment: public from an end user is incoming, public from an agent is an outgoing reply, private is an internal
 * note. An unknown author is taken as an end user. The text is Zendesk's plain body, else its body.
 */
export function commentMessage(
  ticketId: number,
  comment: ZendeskFullComment,
  users: Map<string, ZendeskUser>,
  manifest: Manifest,
  fallback: Date,
): PlannedMessage & { failed: FileFacts["failed"] } {
  const authorId = id(comment.author_id)
  const author = authorId ? users.get(authorId) : undefined
  const isPublic = comment.public !== false
  const direction = !isPublic ? "note" : isAgent(author) ? "out" : "in"
  const email = emailOf(comment)
  const recordedFrom = email.kind === "recorded" ? email.from : null
  const authorAddress = addressOf(author?.email)
  const authorName = text(author?.name)
  const from: MailAddress | null =
    direction === "in"
      ? (recordedFrom?.address ?? authorAddress)
        ? { address: (recordedFrom?.address ?? authorAddress) as string, name: recordedFrom?.name ?? authorName }
        : null
      : recordedFrom?.address
        ? { address: recordedFrom.address, name: recordedFrom.name }
        : null
  const to: MailAddress[] =
    email.kind === "recorded" && email.to?.address ? [{ address: email.to.address, name: email.to.name }] : []
  const cc: MailAddress[] = email.kind === "recorded" ? email.cc.map((address) => ({ address, name: null })) : []
  const { files, failed } = filesOf(comment.attachments, manifest)
  return {
    key: `comment:${String(comment.id)}`,
    direction,
    at: dateOf(comment.created_at, fallback),
    from,
    to,
    cc,
    text: text(comment.plain_body) ?? text(comment.body),
    html: text(comment.html_body),
    headers: [
      authorName,
      from?.name ?? null,
      ...to.map((entry) => entry.name),
      ...(email.kind === "recorded" ? [email.from?.name ?? null, email.to?.name ?? null] : []),
      ...files.map((file) => file.name),
    ].filter((value): value is string => value !== null),
    source: {
      zendeskTicketId: ticketId,
      commentId: String(comment.id),
      sideConversation: null,
      auditId: id(comment.audit_id),
      author: { id: authorId, name: authorName, role: text(author?.role) },
      public: isPublic,
      channel: channelOf(comment),
      email,
      files,
    },
    failed,
  }
}

/** Each message of a side conversation, as an internal note (plan 5.1): its subject, sender, and text. */
export function sideMessages(
  ticketId: number,
  sides: ZendeskSideConversation[],
  manifest: Manifest,
  fallback: Date,
): (PlannedMessage & { failed: FileFacts["failed"] })[] {
  return sides.flatMap((side) =>
    side.events.flatMap((event) => {
      const message = event.message
      if (!message) return []
      const name = text(message.from?.name) ?? text(event.actor?.name)
      const address = addressOf(message.from?.email) ?? addressOf(event.actor?.email)
      const subject = text(message.subject) ?? side.subject
      const { files, failed } = filesOf(message.attachments, manifest)
      return [
        {
          key: `side:${String(event.id)}`,
          direction: "note" as const,
          at: dateOf(event.created_at, fallback),
          from: address ? { address, name } : null,
          to: [],
          cc: [],
          text: text(message.body),
          html: text(message.html_body),
          headers: [name, subject, ...files.map((file) => file.name)].filter(
            (value): value is string => value !== null,
          ),
          source: {
            zendeskTicketId: ticketId,
            commentId: null,
            sideConversation: { id: side.id, eventId: String(event.id), subject },
            auditId: null,
            author: { id: null, name, role: null },
            public: false,
            channel: "side_conversation",
            email: { kind: "none" } as const,
            files,
          },
          failed,
        },
      ]
    }),
  )
}
