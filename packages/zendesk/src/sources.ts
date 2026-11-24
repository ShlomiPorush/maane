export interface IncrementalSource {
  name: string
  path: string
  query: string
  key: string
  kind: "cursor" | "time"
}

export const INCREMENTAL_SOURCES: IncrementalSource[] = [
  {
    name: "tickets",
    path: "/api/v2/incremental/tickets/cursor.json",
    query: "include=metric_sets",
    key: "tickets",
    kind: "cursor",
  },
  { name: "users", path: "/api/v2/incremental/users/cursor.json", query: "", key: "users", kind: "cursor" },
  {
    name: "organizations",
    path: "/api/v2/incremental/organizations.json",
    query: "",
    key: "organizations",
    kind: "time",
  },
]

export interface CollectionSource {
  name: string
  path: string
  key: string
  paged: boolean
}

export const COLLECTION_SOURCES: CollectionSource[] = [
  { name: "brands", path: "/api/v2/brands.json", key: "brands", paged: true },
  { name: "recipient_addresses", path: "/api/v2/recipient_addresses.json", key: "recipient_addresses", paged: true },
  { name: "groups", path: "/api/v2/groups.json", key: "groups", paged: true },
  { name: "tags", path: "/api/v2/tags.json", key: "tags", paged: true },
  { name: "ticket_fields", path: "/api/v2/ticket_fields.json", key: "ticket_fields", paged: true },
  { name: "ticket_forms", path: "/api/v2/ticket_forms.json", key: "ticket_forms", paged: false },
  { name: "custom_statuses", path: "/api/v2/custom_statuses.json", key: "custom_statuses", paged: false },
  { name: "user_fields", path: "/api/v2/user_fields.json", key: "user_fields", paged: true },
  { name: "organization_fields", path: "/api/v2/organization_fields.json", key: "organization_fields", paged: true },
  { name: "satisfaction_ratings", path: "/api/v2/satisfaction_ratings.json", key: "satisfaction_ratings", paged: true },
  { name: "macros", path: "/api/v2/macros.json", key: "macros", paged: true },
  { name: "triggers", path: "/api/v2/triggers.json", key: "triggers", paged: true },
  { name: "automations", path: "/api/v2/automations.json", key: "automations", paged: true },
]

export const PAGE_SIZE = 100

export const MAX_PAGES = 100_000

export function nextPage(body: unknown): string | null {
  const page = body as { meta?: { has_more?: boolean }; links?: { next?: string | null }; next_page?: string | null }
  if (page.meta !== undefined) {
    if (page.meta.has_more === false) return null
    return page.links?.next ?? null
  }
  return page.next_page ?? null
}

export function isTicketId(value: string): boolean {
  return /^\d{1,20}$/.test(value)
}

export function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9-]{1,100}$/.test(value)
}

export function commentsPath(ticketId: string): string {
  return `/api/v2/tickets/${ticketId}/comments.json?include_inline_images=true&page[size]=${PAGE_SIZE}`
}

export function auditsPath(ticketId: string): string {
  return `/api/v2/tickets/${ticketId}/audits.json?page[size]=${PAGE_SIZE}`
}

export function sideConversationsPath(ticketId: string): string {
  return `/api/v2/tickets/${ticketId}/side_conversations.json`
}

export function sideConversationEventsPath(ticketId: string, sideConversationId: string): string {
  return `/api/v2/tickets/${ticketId}/side_conversations/${sideConversationId}/events.json`
}

export function attachmentPath(attachmentId: string): string {
  return `/api/v2/attachments/${attachmentId}.json`
}

export interface ZendeskAttachment {
  id: number | string
  file_name?: string
  name?: string
  content_url?: string | null
  content_type?: string | null
  size?: number | null
  inline?: boolean
}

export interface ZendeskComment {
  id: number | string
  public?: boolean
  attachments?: ZendeskAttachment[]
}

export interface ZendeskSideConversationEvent {
  id: number | string
  message?: { attachments?: ZendeskAttachment[] } | null
}
