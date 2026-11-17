// The words of the ticket list, the ticket view, file preview, and the intake log (plan 2.4) that the server and the
// UI share: which detected types preview and how, and the shapes the API answers with.

import type { ImportedMessageView, ImportedTicketView } from "./imports.ts"
import type {
  IntakeOutcome,
  LinkReason,
  MatchLayer,
  MessageContent,
  PartStatus,
  TextField,
  TicketStatus,
} from "./intake.ts"
import type { TrackedLinkView } from "./links.ts"
import type { ComposeView, DeliveryView, MessageDirection, ReminderView, ScheduledReplyView } from "./replies.ts"
import type { CategoryRef } from "./workflow.ts"

/**
 * How a file previews, by the type read from its content (never the declared one): images, PDF (pdf.js), and text
 * (always served as text/plain; charset=utf-8). SVG, markup, Office files, and everything else download only.
 */
export const PREVIEW_KINDS = ["image", "pdf", "text"] as const
export type PreviewKind = (typeof PREVIEW_KINDS)[number]

export const PREVIEW_TYPES: Readonly<Record<string, PreviewKind>> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "application/pdf": "pdf",
  "text/plain": "text",
}

/** The preview of a stored file: only a clean one, and only of a type in PREVIEW_TYPES. */
export function previewKind(status: string, detectedType: string | null): PreviewKind | null {
  if (status !== "clean" || detectedType === null) return null
  return Object.hasOwn(PREVIEW_TYPES, detectedType) ? (PREVIEW_TYPES[detectedType] ?? null) : null
}

/** The size of a text file the UI previews; a larger one downloads only. */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024

/** Rows per page of the ticket list and the intake log. */
export const TICKETS_PAGE_SIZE = 50
export const INTAKE_PAGE_SIZE = 50

/** The longest search term the ticket list takes (plan 4.4), in UTF-16 code units like the input's maxLength. */
export const SEARCH_MAX_LENGTH = 200

export interface MailAddress {
  address: string
  name: string | null
}

export interface OrganizationRef {
  id: string
  name: string
}

/** A row of the ticket list. */
export interface TicketSummary {
  number: number
  subject: string | null
  status: TicketStatus
  reviewFlags: string[]
  organization: OrganizationRef
  /** The sender of the ticket's first message. */
  customer: MailAddress | null
  messages: number
  createdAt: string
  lastActivityAt: string
  /** Snoozed until this instant (plan 4.2), while that is still ahead; else null. */
  snoozedUntil: string | null
}

export interface TicketList {
  tickets: TicketSummary[]
  /** The cursor of the next page, or null at the end. */
  next: string | null
  /** The organizations the user may see, for the filter. */
  organizations: OrganizationRef[]
  /** Every category, for the filter. */
  categories: CategoryRef[]
}

/** A file of a message: an attachment or an inline part, with its scan status and what may be done with it. */
export interface AttachmentView {
  id: string
  kind: "attachment" | "inline"
  fileName: string | null
  size: number
  status: PartStatus
  signature: string | null
  blockedBy: string | null
  unavailableReason: string | null
  /** Read from the content, for a stored file. */
  detectedType: string | null
  preview: PreviewKind | null
  /** Stored, so it can be downloaded (clean, not fully scanned, or not scanned). */
  download: boolean
}

/** A text field of a message that was not stored as received: blocked, waiting, or too large to scan. */
export interface FieldNotice {
  field: TextField
  status: PartStatus
  signature: string | null
}

export interface MessageView {
  id: string
  /** Incoming mail, an agent's reply, or an internal note. */
  direction: MessageDirection
  /** A reply or a note: the agent who wrote it, by their display name. */
  author: { id: string; name: string } | null
  /** A reply: where sending is, per recipient. */
  delivery: DeliveryView | null
  receivedAt: string
  sentAt: string | null
  from: MailAddress | null
  to: MailAddress[]
  cc: MailAddress[]
  subject: string | null
  content: MessageContent
  reviewFlags: string[]
  /** What the body route serves: the sanitized HTML, the text, or nothing. */
  body: "html" | "text" | null
  /** How many remote images the HTML holds; they are removed until the agent shows them. */
  remoteImages: number
  /** About how many lines the body takes, so the UI can size its frame (a sandboxed frame cannot be measured). */
  bodyLines: number
  /** Changes whenever what the body route serves changes (a waiting field or inline image decided). */
  bodyVersion: string
  fields: FieldNotice[]
  attachments: AttachmentView[]
  /** A reply: its links that were clicked and its history files that were downloaded (plan 3.4). */
  links: TrackedLinkView[]
  /** A reply a scheduled reply made at its time (plan 4.2). */
  scheduled: boolean
  /** An automatic reminder (plan 4.3), sent as the organization: it has no author. */
  reminder: boolean
  /** A comment imported from Zendesk (plan 5.1), or null. */
  imported: ImportedMessageView | null
}

export interface TicketView {
  ticket: {
    number: number
    referenceCode: string
    subject: string | null
    status: TicketStatus
    reviewFlags: string[]
    organization: OrganizationRef
    supportAddress: string
    createdAt: string
    lastActivityAt: string
    /** The ticket's categories, by name. */
    categories: CategoryRef[]
    /** Snoozed until this instant (plan 4.2), while that is still ahead; else null. */
    snoozedUntil: string | null
    /** A snooze whose time passed and that has not ended yet (its job is late): the agent can still end it by hand. */
    snoozeOverdue: boolean
    /** A ticket imported from Zendesk (plan 5.1), or null. */
    imported: ImportedTicketView | null
  }
  participants: MailAddress[]
  /** Tickets this one is linked to, either way, that the user may see. */
  links: { number: number; reason: LinkReason }[]
  messages: MessageView[]
  /** What the composer starts from. */
  compose: ComposeView
  /** Every category, for the ticket's category picker. */
  categories: CategoryRef[]
  /** The organizations the user may move the ticket to (plan 4.1): none when they may not move it. */
  moveTargets: OrganizationRef[]
  /** The ticket's scheduled replies (plan 4.2), newest first, in every state. */
  scheduled: ScheduledReplyView[]
  /** The reminder of the ticket's waiting period that has not gone yet (plan 4.3), or null. */
  reminder: ReminderView | null
}

/** A row of the intake log: what processing did with one message. */
export interface IntakeEntry {
  messageId: string
  at: string
  receivedAt: string
  outcome: IntakeOutcome
  classification: string | null
  /** The record's reason codes (INTAKE_REASONS; an unknown one stays as it is): the intake log shows their words. */
  reasons: string[]
  matchLayer: MatchLayer | null
  subject: string | null
  from: MailAddress | null
  supportAddress: string | null
  organization: OrganizationRef | null
  /** The ticket it opened or joined. */
  ticket: number | null
  /** The ticket it matched. */
  matchedTicket: number | null
  /** The message's review flags and those of its ticket. */
  flags: string[]
}

export interface IntakeLog {
  entries: IntakeEntry[]
  next: string | null
}
