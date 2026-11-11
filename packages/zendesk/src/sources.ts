/** Incremental exports: read from where the previous run stopped. */
export interface IncrementalSource {
  name: string
  path: string
  /** The array that holds the records in each page. */
  key: string
  /** Cursor-based exports continue from `after_cursor`; time-based ones from `end_time`. */
  kind: "cursor" | "time"
}

export const INCREMENTAL_SOURCES: IncrementalSource[] = [
  { name: "tickets", path: "/api/v2/incremental/tickets/cursor.json", key: "tickets", kind: "cursor" },
  { name: "users", path: "/api/v2/incremental/users/cursor.json", key: "users", kind: "cursor" },
  { name: "organizations", path: "/api/v2/incremental/organizations.json", key: "organizations", kind: "time" },
]

/** Small collections: read in full on every run, into a folder of that run. */
export interface CollectionSource {
  name: string
  path: string
  key: string
  /** Whether the endpoint takes cursor pagination (`page[size]`). */
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
]

export const PAGE_SIZE = 100

/** The next page of a list endpoint: cursor pagination first, then the older offset pagination. */
export function nextPage(body: unknown): string | null {
  const page = body as { meta?: { has_more?: boolean }; links?: { next?: string | null }; next_page?: string | null }
  if (page.meta?.has_more && page.links?.next) return page.links.next
  if (page.meta === undefined && page.next_page) return page.next_page
  return null
}

/** The comments of one ticket, with inline images listed as attachments. */
export function commentsPath(ticketId: string): string {
  return `/api/v2/tickets/${encodeURIComponent(ticketId)}/comments.json?include_inline_images=true&page[size]=${PAGE_SIZE}`
}

/** The audit history of one ticket. */
export function auditsPath(ticketId: string): string {
  return `/api/v2/tickets/${encodeURIComponent(ticketId)}/audits.json?page[size]=${PAGE_SIZE}`
}

export interface ZendeskAttachment {
  id: number | string
  file_name?: string
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
