import type { TicketStatus } from "./intake.ts"

export const OPEN_WORK_STATUSES = ["new", "open", "on_hold"] as const satisfies readonly TicketStatus[]

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

export function defaultStatusFilter(searching: boolean): StatusFilter {
  return searching ? "all" : DEFAULT_STATUS_FILTER
}

export function statusesOf(filter: StatusFilter): readonly TicketStatus[] | null {
  if (filter === "all" || filter === "snoozed") return null
  if (filter === "open_work") return OPEN_WORK_STATUSES
  return [filter]
}

export function mayChangeStatus(role: string, from: TicketStatus, to: TicketStatus): boolean {
  if (from === to) return true
  if (from === "closed" || to === "closed") return role === "admin"
  return true
}

export const CATEGORY_NAME_MAX = 80

export interface CategoryRef {
  id: string
  name: string
}

export interface CategoryView extends CategoryRef {
  tickets: number
  createdAt: string
}
