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

const STATUSES: Record<string, TicketStatus> = {
  new: "new",
  open: "open",
  pending: "pending",
  hold: "on_hold",
  on_hold: "on_hold",
  solved: "solved",
  closed: "closed",
}

export const statusOf = (status: string | null | undefined): TicketStatus => STATUSES[status ?? ""] ?? "open"

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)
const id = (value: unknown): string | null =>
  typeof value === "number" || (typeof value === "string" && /^\d{1,20}$/.test(value)) ? String(value) : null
const ids = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap((item) => id(item) ?? []) : [])

export function addressOf(value: unknown): string | null {
  const raw = text(value)
  if (raw === null) return null
  const parsed = parseExactAddress(raw.trim())
  return parsed.ok ? parsed.value : null
}

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

export function followersOf(record: ZendeskTicketRecord, users: Map<string, ZendeskUser>) {
  return ids(record.follower_ids).map((userId) => {
    const user = users.get(userId)
    return { name: text(user?.name), address: addressOf(user?.email) }
  })
}

export interface FieldDefinition {
  title: string
  options: Map<string, string>
}

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

export const tagsOf = (record: ZendeskTicketRecord): string[] =>
  Array.isArray(record.tags) ? [...new Set(record.tags.filter((tag): tag is string => typeof tag === "string"))] : []

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

export interface PlannedMessage {
  key: string
  direction: "in" | "out" | "note"
  at: Date
  from: MailAddress | null
  to: MailAddress[]
  cc: MailAddress[]
  text: string | null
  html: string | null
  headers: string[]
  source: ImportedMessageSource
}

const dateOf = (value: unknown, fallback: Date): Date => {
  const parsed = typeof value === "string" ? new Date(value) : null
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap((item) => (typeof item === "string" ? [item] : [])) : []

const viasOf = (comment: ZendeskFullComment): ZendeskVia[] =>
  [comment.metadata?.via, comment.via].filter((via): via is ZendeskVia => typeof via === "object" && via !== null)

function first<T>(vias: ZendeskVia[], pick: (via: ZendeskVia) => T | null): T | null {
  for (const via of vias) {
    const value = pick(via)
    if (value !== null) return value
  }
  return null
}

function firstList<T>(vias: ZendeskVia[], pick: (via: ZendeskVia) => T[]): T[] {
  for (const via of vias) {
    const value = pick(via)
    if (value.length > 0) return value
  }
  return []
}

export function emailOf(comment: ZendeskFullComment): EmailIdentifiers {
  const system = (comment.metadata?.system ?? {}) as Record<string, unknown>
  const rawId = text(system.message_id)
  const messageId = rawId ? rawId.replace(/^<|>$/g, "").slice(0, 998) : null
  const vias = viasOf(comment)
  const original = firstList(vias, (via) =>
    strings(via.source?.from?.original_recipients).flatMap((value) => addressOf(value) ?? []),
  )
  const cc = firstList(vias, (via) => strings(via.source?.to?.email_ccs).flatMap((value) => addressOf(value) ?? []))
  const party = (side: "from" | "to") =>
    first(vias, (via) => {
      const address = addressOf(via.source?.[side]?.address)
      const name = text(via.source?.[side]?.name)
      return address || name ? { address, name } : null
    })
  const from = party("from")
  const to = party("to")
  if (!messageId && !from?.address && !to?.address && original.length === 0 && cc.length === 0) return { kind: "none" }
  return {
    kind: "recorded",
    messageId,
    from,
    to,
    cc,
    originalRecipients: original,
  }
}

function channelOf(comment: ZendeskFullComment): string | null {
  return first(viasOf(comment), (via) =>
    typeof via.channel === "string" || typeof via.channel === "number" ? String(via.channel) : null,
  )
}

const isAgent = (user: ZendeskUser | undefined) => user?.role === "agent" || user?.role === "admin"

export interface ArchivedFile {
  id: string
  name: string | null
  declaredType: string | null
  inline: boolean
  sha256: string
  bytes: number
  contentUrl: string | null
}

export interface FileFacts {
  files: ImportedMessageSource["files"]
  failed: { id: string; name: string | null }[]
  archived: ArchivedFile[]
  unusable: { name: string | null }[]
}

const attachmentId = (value: unknown): string | null =>
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
  (typeof value === "string" && /^[0-9A-Za-z_-]{1,64}$/.test(value))
    ? String(value)
    : null

export function filesOf(attachments: unknown, manifest: Manifest): FileFacts {
  const files: ImportedMessageSource["files"] = []
  const failed: FileFacts["failed"] = []
  const archived: ArchivedFile[] = []
  const unusable: FileFacts["unusable"] = []
  const seen = new Set<string>()
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const entry = (attachment ?? {}) as { id?: unknown; file_name?: unknown; name?: unknown; inline?: unknown }
    const name = text(entry.file_name) ?? text(entry.name)
    const fileId = attachmentId(entry.id)
    if (!fileId) {
      unusable.push({ name })
      continue
    }
    if (seen.has(fileId)) continue
    seen.add(fileId)
    const recorded = manifest.files[fileId]
    const ok = recorded?.status === "ok" && typeof recorded.sha256 === "string" && typeof recorded.bytes === "number"
    const status = ok ? "ok" : recorded ? "failed" : "missing"
    files.push({ id: fileId, name, inline: entry.inline === true, status })
    if (!ok) failed.push({ id: fileId, name })
    else
      archived.push({
        id: fileId,
        name,
        declaredType: text(recorded.contentType),
        inline: entry.inline === true || recorded.inline === true,
        sha256: recorded.sha256 as string,
        bytes: recorded.bytes as number,
        contentUrl: text(recorded.contentUrl),
      })
  }
  return { files, failed, archived, unusable }
}

export const importedContentId = (attachmentId: string) => `zendesk-${attachmentId}`

export function inlineImages(files: ArchivedFile[]): { rewrite: (src: string) => string | null; used: Set<string> } {
  const byUrl = new Map(files.flatMap((file) => (file.contentUrl ? [[file.contentUrl, file.id] as const] : [])))
  const used = new Set<string>()
  return {
    used,
    rewrite: (src) => {
      const fileId = byUrl.get(src.trim())
      if (fileId === undefined) return null
      used.add(fileId)
      return `cid:${importedContentId(fileId)}`
    },
  }
}

export function commentMessage(
  ticketId: number,
  comment: ZendeskFullComment,
  users: Map<string, ZendeskUser>,
  manifest: Manifest,
  fallback: Date,
): PlannedMessage & Pick<FileFacts, "failed" | "archived" | "unusable"> {
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
  const { files, failed, archived, unusable } = filesOf(comment.attachments, manifest)
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
      ...unusable.map((file) => file.name),
      ...archived.map((file) => file.declaredType),
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
    archived,
    unusable,
  }
}

export function sideMessages(
  ticketId: number,
  sides: ZendeskSideConversation[],
  manifest: Manifest,
  fallback: Date,
): (PlannedMessage & Pick<FileFacts, "failed" | "archived" | "unusable">)[] {
  return sides.flatMap((side) =>
    side.events.flatMap((event) => {
      const message = event.message
      if (!message) return []
      const name = text(message.from?.name) ?? text(event.actor?.name)
      const address = addressOf(message.from?.email) ?? addressOf(event.actor?.email)
      const subject = text(message.subject) ?? side.subject
      const { files, failed, archived, unusable } = filesOf(message.attachments, manifest)
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
          headers: [
            name,
            subject,
            ...files.map((file) => file.name),
            ...unusable.map((file) => file.name),
            ...archived.map((file) => file.declaredType),
          ].filter((value): value is string => value !== null),
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
          archived,
          unusable,
        },
      ]
    }),
  )
}
