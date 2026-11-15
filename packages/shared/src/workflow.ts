// The words of the workflow (plans 4.1 and 4.2) that the server and the UI share: the statuses of open work, who may set
// which status, the ticket list's status filter (snoozed tickets included), and categories.

import type { TicketStatus } from "./intake.ts"

/** Open work: the ticket list's default view (plan 4.1). */
export const OPEN_WORK_STATUSES = ["new", "open", "on_hold"] as const satisfies readonly TicketStatus[]

/**
 * The ticket list's status filter: open work (the default, without snoozed tickets), every status, one status, or the
 * snoozed tickets of every status (plan 4.2). The address and the API carry it as `status`; without it the list shows
 * open work, and a search every status, snoozed tickets among them (plan 4.4).
 */
export const STATUS_FILTERS = [
  "open_work",
  "all",
  "new",
  "open",
  "pending",
  "on_hold",
  "solved",
  "closed",
  "snoozed",
] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]
export const DEFAULT_STATUS_FILTER: StatusFilter = "open_work"

/** The status filter when none is chosen: open work, or every status while searching (plan 4.4). */
export function defaultStatusFilter(searching: boolean): StatusFilter {
  return searching ? "all" : DEFAULT_STATUS_FILTER
}

/** The statuses a filter shows, or null for every status. */
export function statusesOf(filter: StatusFilter): readonly TicketStatus[] | null {
  if (filter === "all" || filter === "snoozed") return null
  if (filter === "open_work") return OPEN_WORK_STATUSES
  return [filter]
}

/**
 * Whether a user of this role may change a ticket from one status to another: `closed` is set and left only by an
 * admin (plan 4.1). The server decides with this function; the UI only mirrors it.
 */
export function mayChangeStatus(role: string, from: TicketStatus, to: TicketStatus): boolean {
  if (from === to) return true
  if (from === "closed" || to === "closed") return role === "admin"
  return true
}

/** A category's name: trimmed, 1 to 80 characters, unique without regard to case. */
export const CATEGORY_NAME_MAX = 80

export interface CategoryRef {
  id: string
  name: string
}

/** A category in the admin list, with how many tickets carry it. */
export interface CategoryView extends CategoryRef {
  tickets: number
  createdAt: string
}
