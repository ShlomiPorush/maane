import type { ImportedField, ImportedMessageView, ImportedTicketView } from "@maane/shared"

export interface ImportedTicketSource {
  brand: { id: string; name: string | null }
  tags: string[]
  fields: ImportedField[]
  followers: { name: string | null; address: string | null }[]
  links: { zendeskId: number; reason: "merged" | "follow_up" }[]
  status: string
  updatedAt: string
  blocked?: boolean
}

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
  commentId: string | null
  sideConversation: { id: string; eventId: string; subject: string | null } | null
  auditId: string | null
  author: { id: string | null; name: string | null; role: string | null }
  public: boolean
  channel: string | null
  email: EmailIdentifiers
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
