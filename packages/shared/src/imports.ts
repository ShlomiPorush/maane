// The words of the import from the Zendesk archive (plan 5.1) that the server, the worker, and the UI share: the states
// of a run, why a run was refused or stopped, the reasons of the report, and the shapes of the import page.

import type { IntakeMode } from "./settings.ts"
import type { OrganizationRef } from "./tickets.ts"
import type { CategoryRef } from "./workflow.ts"

/**
 * A run's state: `running` (started, its job active or waiting to go on after a crash), `done`, `stopped` (the archive
 * changed under it, the window closed, or an admin cancelled it: the next start is a full pass), or `refused` (nothing
 * was written).
 */
export const IMPORT_RUN_STATES = ["running", "done", "stopped", "refused"] as const
export type ImportRunState = (typeof IMPORT_RUN_STATES)[number]

/**
 * Why a run was refused or stopped, or a start refused:
 * - `went_live`: Maane went live; the import window is closed for good.
 * - `not_listening`: the intake mode is not listening.
 * - `no_agent`: no Maane user was chosen for the comments of Zendesk agents.
 * - `no_archive`: no archive at the mount.
 * - `backup_running`: the backup tool holds the archive's lock; finish the backup first.
 * - `archive_incomplete`: the strict offline check found problems.
 * - `other_origin`: the archive comes from another Zendesk account than earlier imports.
 * - `archive_changed`: a backup ran or started during the run (or between its check and its first write).
 * - `scanner`: the scanner did not answer; the run goes on when it does.
 * - `failed`: the run stopped on an error and waits, open; when a ticket caused it, its `ticket_failed` report row
 *   names the ticket and why, and otherwise the run's `failure` names the stage and the kind of error. Continue goes on
 *   from the last committed ticket once the cause is fixed.
 * - `cancelled`: an admin cancelled the open run. What it imported stays; the next start is a full pass.
 */
export const IMPORT_STOP_REASONS = [
  "went_live",
  "not_listening",
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

/**
 * What the report lists:
 * - `unmapped_brand`: the ticket's brand maps to no organization; it was not imported.
 * - `deleted_in_zendesk`: the archive marks the ticket deleted; it was not imported (owner's decision 3).
 * - `number_taken`: a ticket Maane opened already has this number; it was not imported.
 * - `file_failed`: the manifest marks a file of the ticket failed; it is not in Maane (the import never asks Zendesk).
 * - `file_infected`: the scanner found a file of the ticket infected; it was not stored (plan 5.2).
 * - `file_blocked`: a file of the ticket is of a blocked type; it was not stored (plan 5.2).
 *   The detail of the three file reasons is the file's name, or its Zendesk ID when the scanner blocked the names of
 *   its comment.
 * - `blocked_content`: the scanner blocked a text of a comment, which was kept without it.
 * - `ticket_failed`: the ticket could not be saved, so the run stopped there (the last such error of the run). Its
 *   detail is an IMPORT_FAILURES kind, then `:` and the database constraint's name when one was named; never the
 *   error's text, which may hold the row's values.
 */
export const IMPORT_REPORT_REASONS = [
  "unmapped_brand",
  "deleted_in_zendesk",
  "number_taken",
  "file_failed",
  "file_infected",
  "file_blocked",
  "blocked_content",
  "ticket_failed",
] as const
export type ImportReportReason = (typeof IMPORT_REPORT_REASONS)[number]

/**
 * Where a run stopped on an error no ticket caused: `start` (preparing the run in the database), `archive` (reading or
 * checking the archive), or `links` (linking the imported tickets and continuing the ticket numbers).
 */
export const IMPORT_STAGES = ["start", "archive", "links"] as const
export type ImportStage = (typeof IMPORT_STAGES)[number]

/** Why a ticket could not be saved: a key already held, a database rule, a missing row, a value, the archive, other. */
export const IMPORT_FAILURES = ["duplicate", "rule", "reference", "value", "archive", "other"] as const
export type ImportFailure = (typeof IMPORT_FAILURES)[number]

/** What a run counted. `files`: the files its comments list, whatever became of each (plan 5.2). */
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

/** Rows per page of a run's report. */
export const IMPORT_REPORT_PAGE_SIZE = 50

export interface ImportRunView {
  id: string
  state: ImportRunState
  reason: ImportStopReason | null
  /** The first problems of a failed archive check, as the check wrote them. */
  problems: string[]
  /**
   * For an open run stopped by an error no ticket caused: the stage, the kind of error, and the database constraint it
   * named, if any. Never the error's text.
   */
  failure: { stage: ImportStage; kind: ImportFailure; constraint: string | null } | null
  createdAt: string
  finishedAt: string | null
  coveredUntil: string | null
  highestNumber: number | null
  total: number
  done: number
  counts: ImportCounts
  reportRows: number
  /**
   * Whether a job is queued, waiting to retry, or working on this run. A running run without one (its job used up its
   * retries) waits for Continue.
   */
  jobActive: boolean
  /** Whether the run's only job failed and pg-boss tries it again by itself later: nothing for the admin to do yet. */
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

/** The archive at the mount, as the import page shows it. */
export interface ImportArchiveView {
  /** Whether an archive is at the mount. */
  present: boolean
  /** The Zendesk account it was made from. */
  origin: string | null
  /** Backup runs that wrote it, and the time its tickets cover. */
  runs: number
  coveredUntil: string | null
  /** The backup tool holds its lock. */
  backupRunning: boolean
  /** The archive was made from another account than earlier imports. */
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
  /** The import window: open while intake listens and Maane never went live. */
  window: { open: boolean; mode: IntakeMode; wentLiveAt: string | null }
  archive: ImportArchiveView
  brands: ImportBrandView[]
  tags: ImportTagView[]
  /** The Maane user Zendesk agents' comments and notes are attributed to. */
  agentUserId: string | null
  /** Users who may be chosen: admins and agents, not disabled. */
  users: { id: string; name: string }[]
  organizations: OrganizationRef[]
  categories: CategoryRef[]
  /** The newest run, or null. */
  run: ImportRunView | null
}

/** The mapping the import page saves: each brand to an organization or none, each tag to a category or none. */
export interface ImportMappingInput {
  brands: Record<string, string | null>
  tags: Record<string, string | null>
  agentUserId: string | null
}

/** A field of a Zendesk ticket as the "From Zendesk" block shows it. */
export interface ImportedField {
  name: string
  value: string
}

/** What the ticket view shows of an imported ticket. */
export interface ImportedTicketView {
  zendeskId: number
  /** Read-only until Maane first goes live. */
  readOnly: boolean
  brand: string | null
  tags: string[]
  fields: ImportedField[]
  /** Followers: source information, never recipients. */
  followers: { name: string | null; address: string | null }[]
}

/** What the ticket view shows of an imported comment. */
export interface ImportedMessageView {
  /** The Zendesk author's name as recorded. */
  authorName: string | null
  /** A message of a side conversation, kept as an internal note. */
  sideConversation: boolean
}
