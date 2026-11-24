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

export function previewKind(status: string, detectedType: string | null): PreviewKind | null {
  if (status !== "clean" || detectedType === null) return null
  return Object.hasOwn(PREVIEW_TYPES, detectedType) ? (PREVIEW_TYPES[detectedType] ?? null) : null
}

export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024

export const TICKETS_PAGE_SIZE = 50
export const INTAKE_PAGE_SIZE = 50

export const SEARCH_MAX_LENGTH = 200

export interface MailAddress {
  address: string
  name: string | null
}

export interface OrganizationRef {
  id: string
  name: string
}

export interface TicketSummary {
  number: number
  subject: string | null
  status: TicketStatus
  reviewFlags: string[]
  organization: OrganizationRef
  customer: MailAddress | null
  messages: number
  createdAt: string
  lastActivityAt: string
  snoozedUntil: string | null
}

export interface TicketList {
  tickets: TicketSummary[]
  next: string | null
  organizations: OrganizationRef[]
  categories: CategoryRef[]
}

export interface AttachmentView {
  id: string
  kind: "attachment" | "inline"
  fileName: string | null
  size: number
  status: PartStatus
  signature: string | null
  blockedBy: string | null
  unavailableReason: string | null
  detectedType: string | null
  preview: PreviewKind | null
  download: boolean
}

export interface FieldNotice {
  field: TextField
  status: PartStatus
  signature: string | null
}

export interface MessageView {
  id: string
  direction: MessageDirection
  author: { id: string; name: string } | null
  delivery: DeliveryView | null
  receivedAt: string
  sentAt: string | null
  from: MailAddress | null
  to: MailAddress[]
  cc: MailAddress[]
  subject: string | null
  content: MessageContent
  reviewFlags: string[]
  body: "html" | "text" | null
  remoteImages: number
  bodyLines: number
  bodyVersion: string
  fields: FieldNotice[]
  attachments: AttachmentView[]
  links: TrackedLinkView[]
  scheduled: boolean
  reminder: boolean
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
    categories: CategoryRef[]
    snoozedUntil: string | null
    snoozeOverdue: boolean
    imported: ImportedTicketView | null
  }
  participants: MailAddress[]
  links: { number: number; reason: LinkReason }[]
  messages: MessageView[]
  compose: ComposeView
  categories: CategoryRef[]
  moveTargets: OrganizationRef[]
  scheduled: ScheduledReplyView[]
  reminder: ReminderView | null
}

export interface IntakeEntry {
  messageId: string
  at: string
  receivedAt: string
  outcome: IntakeOutcome
  classification: string | null
  reasons: string[]
  matchLayer: MatchLayer | null
  subject: string | null
  from: MailAddress | null
  supportAddress: string | null
  organization: OrganizationRef | null
  ticket: number | null
  matchedTicket: number | null
  flags: string[]
}

export interface IntakeLog {
  entries: IntakeEntry[]
  next: string | null
}
