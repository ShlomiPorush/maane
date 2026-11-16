// What the import (plan 5.1) keeps of a Zendesk ticket and comment beside Maane's own columns, as stored in their
// `zendesk` JSON columns, and how the ticket view reads it back. The worker writes these shapes; everything read back
// is checked field by field, so an older or damaged value shows as absent.

import type { ImportedField, ImportedMessageView, ImportedTicketView } from "@maane/shared"

export interface ImportedTicketSource {
  brand: { id: string; name: string | null }
  /** The ticket's tags as Zendesk kept them; the categories come from the tag mapping. */
  tags: string[]
  /** Custom fields with a value, by the field's name. */
  fields: ImportedField[]
  /** Followers: source information only, never recipients. */
  followers: { name: string | null; address: string | null }[]
  /** Merged and follow-up tickets this ticket names, by Zendesk ID. */
  links: { zendeskId: number; reason: "merged" | "follow_up" }[]
  /** The Zendesk status as recorded. */
  status: string
  updatedAt: string
  /** The scanner refused the ticket's own texts: its subject, fields, tags, and names were not stored. */
  blocked?: boolean
}

/** The email identifiers Zendesk recorded for a comment, or the explicit mark that it recorded none. */
export type EmailIdentifiers =
  | {
      kind: "recorded"
      messageId: string | null
      from: { address: string | null; name: string | null } | null
      to: { address: string | null; name: string | null } | null
      cc: string[]
      originalRecipients: string[]
    }
  | { kind: "none" }

export interface ImportedMessageSource {
  zendeskTicketId: number
  /** The comment's ID, or the side conversation's and its event's. */
  commentId: string | null
  sideConversation: { id: string; eventId: string; subject: string | null } | null
  auditId: string | null
  author: { id: string | null; name: string | null; role: string | null }
  public: boolean
  channel: string | null
  email: EmailIdentifiers
  /** The comment's files as Zendesk listed them; those the manifest holds are its message's parts (plan 5.2). */
  files: { id: string; name: string | null; inline: boolean; status: "ok" | "failed" | "missing" }[]
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null)

export function ticketSourceView(zendeskId: number, value: unknown, readOnly: boolean): ImportedTicketView {
  const source = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>
  const brand = (source.brand ?? {}) as Record<string, unknown>
  const fields = Array.isArray(source.fields) ? source.fields : []
  const followers = Array.isArray(source.followers) ? source.followers : []
  return {
    zendeskId,
    readOnly,
    brand: text(brand.name) ?? text(brand.id),
    tags: Array.isArray(source.tags) ? source.tags.filter((tag): tag is string => typeof tag === "string") : [],
    fields: fields.flatMap((field) => {
      const name = text((field as Record<string, unknown>)?.name)
      const fieldValue = text((field as Record<string, unknown>)?.value)
      return name !== null && fieldValue !== null ? [{ name, value: fieldValue }] : []
    }),
    followers: followers.map((follower) => ({
      name: text((follower as Record<string, unknown>)?.name),
      address: text((follower as Record<string, unknown>)?.address),
    })),
  }
}

export function messageSourceView(value: unknown): ImportedMessageView {
  const source = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>
  const author = (source.author ?? {}) as Record<string, unknown>
  return {
    authorName: text(author.name),
    sideConversation: typeof source.sideConversation === "object" && source.sideConversation !== null,
  }
}
