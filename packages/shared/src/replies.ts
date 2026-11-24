import type { DeliverySource, DeliveryStatus } from "./delivery.ts"
import type { MailAddress } from "./tickets.ts"

export const MESSAGE_DIRECTIONS = ["in", "out", "note"] as const
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number]

export const OUTBOX_STATES = ["pending", "sending", "accepted", "failed", "unknown"] as const
export type OutboxState = (typeof OUTBOX_STATES)[number]

export const RECIPIENT_STATES = ["pending", "accepted", "refused", "unknown"] as const
export type RecipientState = (typeof RECIPIENT_STATES)[number]

export function outboxStateOf(
  states: readonly string[],
  configured: boolean,
): { state: OutboxState; problem: SendProblem | null } {
  if (states.includes("unknown")) return { state: "unknown", problem: null }
  if (states.includes("accepted")) return { state: "accepted", problem: null }
  if (states.every((state) => state === "pending"))
    return { state: "failed", problem: configured ? "unreachable" : "not_configured" }
  return { state: "failed", problem: null }
}

export const PROVIDERS = ["smtp2go", "failover"] as const
export type Provider = (typeof PROVIDERS)[number]

export const SEND_PROBLEMS = [
  "from_not_allowed",
  "author_not_allowed",
  "not_configured",
  "unreachable",
  "customer_reply",
  "action_ended",
  "reminder_ended",
] as const
export type SendProblem = (typeof SEND_PROBLEMS)[number]

export const UPLOAD_STATUSES = [
  "scanning",
  "clean",
  "not_fully_scanned",
  "not_scanned",
  "infected",
  "blocked_type",
  "too_large",
  "scanner_unavailable",
] as const
export type UploadStatus = (typeof UPLOAD_STATUSES)[number]
export const ATTACHABLE_UPLOAD_STATUSES = ["clean", "not_fully_scanned", "not_scanned"] as const

export const SIGNATURE_MAX = 2000
export const RECIPIENTS_MAX = 50
export const ATTACHMENTS_MAX = 20
export const REPLY_HTML_MAX = 500_000

export const MESSAGE_MAX_MB = 50
export const MESSAGE_MAX_BYTES = MESSAGE_MAX_MB * 1_000_000
export const AGENT_NAME_MAX = 80

export interface UploadView {
  id: string
  fileName: string
  size: number
  status: UploadStatus
  signature: string | null
  blockedBy: string | null
}

export interface RecipientView extends MailAddress {
  kind: "to" | "cc"
  state: RecipientState
  provider: Provider | null
  marked: boolean
  delivery: DeliveryStatus | null
  deliveryAt: string | null
  deliveryDetail: string | null
}

export interface UnmatchedDelivery {
  source: DeliverySource
  recordedAt: string
  status: DeliveryStatus | null
  at: string | null
  recipient: string | null
  messageId: string | null
}

export interface DeliveryView {
  state: OutboxState
  problem: SendProblem | null
  recipients: RecipientView[]
  unmatchedDelivery: UnmatchedDelivery | null
  scheduledEnded: boolean
  reminder: boolean
  reminderResend: boolean
}

export interface ComposeView {
  from: string[]
  defaultFrom: string | null
  to: MailAddress[]
  cc: MailAddress[]
  signature: string
  senderName: string
}

export interface ReplyInput {
  submissionId: string
  kind: "reply" | "note"
  from: string | null
  to: MailAddress[]
  cc: MailAddress[]
  html: string
  uploads: string[]
  parts: string[]
  setPending?: boolean
  sendAt?: string
}

export const ACTION_STATES = ["scheduled", "handed", "done", "cancelled", "ended"] as const
export type ActionState = (typeof ACTION_STATES)[number]

export const ACTION_REASONS = [
  "agent",
  "customer_reply",
  "move",
  "from_not_allowed",
  "author_not_allowed",
  "status_change",
  "agent_reply",
  "delivery_failed",
  "no_template",
  "no_recipients",
] as const
export type ActionReason = (typeof ACTION_REASONS)[number]

export const PERIOD_END_REASONS = ["customer_reply", "status_change", "agent_reply", "move", "delivery_failed"] as const
export type PeriodEndReason = (typeof PERIOD_END_REASONS)[number]

export const REMINDER_TEMPLATE_MAX = 2000
export const REMINDER_DAYS_MIN = 1
export const REMINDER_DAYS_MAX = 60

export interface ReminderView {
  id: string
  dueAt: string
  state: ActionState
}

export interface ScheduledFile {
  source: "upload" | "part"
  id: string
  fileName: string
  size: number
}

export interface ScheduledReplyView {
  id: string
  version: number
  state: ActionState
  reason: ActionReason | null
  sendAt: string
  createdAt: string
  updatedAt: string
  author: { id: string; name: string } | null
  editable: boolean
  from: string
  to: MailAddress[]
  cc: MailAddress[]
  text: string
  html: string
  setPending: boolean
  files: ScheduledFile[]
  messageId: string | null
  outboxState: OutboxState | null
}

export interface ScheduledInput extends Omit<ReplyInput, "submissionId" | "kind" | "sendAt"> {
  sendAt: string
  version: number
}

export const SMTP_PROBLEMS = ["not_configured", "connection", "tls", "auth", "error"] as const
export type SmtpProblem = (typeof SMTP_PROBLEMS)[number]

export interface SmtpTestResult {
  provider: Provider
  ok: boolean
  problem: SmtpProblem | null
  code: string | null
  response: string | null
  checkedAt: string
}

export interface SmtpTestView {
  state: "queued" | "running" | "done" | "failed"
  result: SmtpTestResult | null
}
