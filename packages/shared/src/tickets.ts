// The words of the ticket list, the ticket view, file preview, and the intake log (plan 2.4) that the server and the
// UI share: which detected types preview and how, and the shapes the API answers with.

import type { IntakeOutcome, MatchLayer, MessageContent, PartStatus, TextField, TicketStatus } from "./intake.ts"

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
}

export interface TicketList {
  tickets: TicketSummary[]
  /** The cursor of the next page, or null at the end. */
  next: string | null
  /** The organizations the user may see, for the filter. */
  organizations: OrganizationRef[]
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
  }
  participants: MailAddress[]
  /** Tickets this one is linked to, either way, that the user may see. */
  links: { number: number; reason: string }[]
  messages: MessageView[]
}

/** A row of the intake log: what processing did (live) or would have done (listening) with one message. */
export interface IntakeEntry {
  messageId: string
  at: string
  receivedAt: string
  mode: "listening" | "live"
  outcome: IntakeOutcome
  classification: string | null
  /** The record's reason codes (INTAKE_REASONS; an unknown one stays as it is): the intake log shows their words. */
  reasons: string[]
  matchLayer: MatchLayer | null
  subject: string | null
  from: MailAddress | null
  supportAddress: string | null
  organization: OrganizationRef | null
  /** Live: the ticket it opened or joined. */
  ticket: number | null
  /** The ticket it matched (live) or would have matched (listening). */
  matchedTicket: number | null
  /** The message's review flags and those of its ticket or listening conversation. */
  flags: string[]
}

export interface IntakeLog {
  entries: IntakeEntry[]
  next: string | null
}

/** The modes and the review choice the intake log filters by. */
export const INTAKE_FILTER_MODES = ["listening", "live"] as const
