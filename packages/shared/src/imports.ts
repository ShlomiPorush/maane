import type { OrganizationRef } from "./tickets.ts"
import type { CategoryRef } from "./workflow.ts"

export const IMPORT_RUN_STATES = ["running", "done", "stopped", "refused"] as const
export type ImportRunState = (typeof IMPORT_RUN_STATES)[number]

export const IMPORT_STOP_REASONS = [
  "no_agent",
  "no_archive",
  "backup_running",
  "archive_incomplete",
  "other_origin",
  "archive_changed",
  "scanner",
  "failed",
  "cancelled",
] as const
export type ImportStopReason = (typeof IMPORT_STOP_REASONS)[number]

export const IMPORT_REPORT_REASONS = [
  "unmapped_brand",
  "deleted_in_zendesk",
  "number_taken",
  "file_failed",
  "file_infected",
  "file_blocked",
  "file_unusable_id",
  "blocked_content",
  "kept_live_changes",
  "ticket_failed",
] as const
export type ImportReportReason = (typeof IMPORT_REPORT_REASONS)[number]

export const IMPORT_STAGES = ["start", "archive", "links"] as const
export type ImportStage = (typeof IMPORT_STAGES)[number]

export const IMPORT_FAILURES = ["duplicate", "rule", "reference", "value", "archive", "other"] as const
export type ImportFailure = (typeof IMPORT_FAILURES)[number]

export interface ImportCounts {
  tickets: number
  messages: number
  notes: number
  sideConversations: number
  links: number
  files: number
  skipped: number
}

export const emptyImportCounts = (): ImportCounts => ({
  tickets: 0,
  messages: 0,
  notes: 0,
  sideConversations: 0,
  links: 0,
  files: 0,
  skipped: 0,
})

export const IMPORT_REPORT_PAGE_SIZE = 50

export interface ImportRunView {
  id: string
  state: ImportRunState
  reason: ImportStopReason | null
  problems: string[]
  failure: { stage: ImportStage; kind: ImportFailure; constraint: string | null } | null
  createdAt: string
  finishedAt: string | null
  coveredUntil: string | null
  highestNumber: number | null
  total: number
  done: number
  counts: ImportCounts
  reportRows: number
  jobActive: boolean
  retrying: boolean
}

export interface ImportReportRow {
  id: number
  zendeskId: number
  reason: ImportReportReason
  detail: string | null
}

export interface ImportReportPage {
  rows: ImportReportRow[]
  next: string | null
}

export interface ImportArchiveView {
  present: boolean
  origin: string | null
  runs: number
  coveredUntil: string | null
  backupRunning: boolean
  otherOrigin: boolean
  tickets: number
}

export interface ImportBrandView {
  id: string
  name: string
  tickets: number
  organizationId: string | null
}

export interface ImportTagView {
  tag: string
  tickets: number
  categoryId: string | null
}

export interface ImportView {
  window: { open: boolean; finishedAt: string | null }
  archive: ImportArchiveView
  brands: ImportBrandView[]
  tags: ImportTagView[]
  agentUserId: string | null
  users: { id: string; name: string }[]
  organizations: OrganizationRef[]
  categories: CategoryRef[]
  run: ImportRunView | null
}

export interface ImportMappingInput {
  brands: Record<string, string | null>
  tags: Record<string, string | null>
  agentUserId: string | null
}

export interface ImportedField {
  name: string
  value: string
}

export interface ImportedTicketView {
  zendeskId: number
  readOnly: boolean
  brand: string | null
  tags: string[]
  fields: ImportedField[]
  followers: { name: string | null; address: string | null }[]
}

export interface ImportedMessageView {
  authorName: string | null
  sideConversation: boolean
}
