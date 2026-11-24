// The words of replies that send (plan 3.1) that the server, the worker, and the UI share: message directions, the
// states of an outgoing message and of each recipient, why a send did not happen, uploads, and the shapes the composer
// and the ticket view use.

import type { DeliverySource, DeliveryStatus } from "./delivery.ts"
import type { MailAddress } from "./tickets.ts"

/** `in` came through intake; `out` is an agent's reply; `note` is an internal note, never sent. */
export const MESSAGE_DIRECTIONS = ["in", "out", "note"] as const
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number]

/**
 * Where an outgoing message is, from its recipients (requirements 2.3):
 * - `pending`: queued, no attempt started.
 * - `sending`: an attempt started and has not finished.
 * - `accepted`: every recipient was accepted, or some were and the others refused by both providers.
 * - `failed`: nothing was accepted: every recipient refused, or a check at send time refused it (SEND_PROBLEMS).
 * - `unknown`: a provider may have taken it for some recipient; nothing is sent again until the agent decides.
 */
export const OUTBOX_STATES = ["pending", "sending", "accepted", "failed", "unknown"] as const
export type OutboxState = (typeof OUTBOX_STATES)[number]

/**
 * What a provider said about one recipient: `accepted` (the final 250), `refused` (refused at RCPT TO, or the message
 * refused after its data), or `unknown` (the connection dropped or timed out while the message was being sent).
 */
export const RECIPIENT_STATES = ["pending", "accepted", "refused", "unknown"] as const
export type RecipientState = (typeof RECIPIENT_STATES)[number]

/**
 * The state of an outgoing message from its recipients' states: unknown while any is, accepted once any was, else
 * failed; with no recipient answered at all, the problem says why (no provider set up, or none reachable).
 */
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

/** The SMTP servers Maane sends through: SMTP2GO first, then the failover. */
export const PROVIDERS = ["smtp2go", "failover"] as const
export type Provider = (typeof PROVIDERS)[number]

/**
 * Why nothing was sent (the message `failed`):
 * - `from_not_allowed`: the From address no longer belongs to the ticket's organization.
 * - `author_not_allowed`: the author may no longer answer this ticket (removed, disabled, or out of its organization).
 * - `not_configured`: neither SMTP2GO nor the failover server is set up.
 * - `unreachable`: no provider could be reached or logged in to, so nothing was sent.
 * - `customer_reply`: a scheduled reply (plan 4.2) whose customer wrote before it went out.
 * - `action_ended`: a scheduled reply cancelled or replaced before it went out.
 * - `reminder_ended`: an automatic reminder (plan 4.3) whose waiting period ended before it went out.
 */
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

/**
 * An upload's state: `scanning` until the worker decided; a stored file (`clean`, `not_fully_scanned`, `not_scanned`),
 * which may be attached; or a refusal (`infected`, `blocked_type`, `too_large`, `scanner_unavailable`: the scanner
 * could not answer and the policy blocks).
 */
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
/** The upload statuses that hold a stored file, which may be attached. */
export const ATTACHABLE_UPLOAD_STATUSES = ["clean", "not_fully_scanned", "not_scanned"] as const

/** The longest signature an organization keeps, in characters. */
export const SIGNATURE_MAX = 2000
/** The most recipients one reply may have (To and Cc together). */
export const RECIPIENTS_MAX = 50
export const ATTACHMENTS_MAX = 20
/** The longest reply text the composer sends, in characters of HTML. */
export const REPLY_HTML_MAX = 500_000

/**
 * The largest whole message SMTP2GO takes, attachments and encoding included: "up to 50MB per email" (SMTP2GO's FAQ,
 * https://www.smtp2go.com/faq, and its support article "Maximum Attachment Size",
 * https://support.smtp2go.com/hc/en-gb/articles/223087547-Maximum-Attachment-Size, read 2026-11-13). Read as 50,000,000
 * bytes, the smaller reading of MB. A reply whose message is still larger once its history is trimmed is refused before
 * it is queued (plan 3.2).
 */
export const MESSAGE_MAX_MB = 50
export const MESSAGE_MAX_BYTES = MESSAGE_MAX_MB * 1_000_000
/** The longest agent display name, in characters. */
export const AGENT_NAME_MAX = 80

export interface UploadView {
  id: string
  fileName: string
  size: number
  status: UploadStatus
  signature: string | null
  blockedBy: string | null
}

/** A recipient of an outgoing message as the ticket view shows it. */
export interface RecipientView extends MailAddress {
  kind: "to" | "cc"
  state: RecipientState
  provider: Provider | null
  /** An agent marked this unknown recipient as sent. */
  marked: boolean
  /** What the recipient's server did with it, once a provider or a delivery report said (plan 3.3). */
  delivery: DeliveryStatus | null
  /** When that happened, by the provider's or the report's time. */
  deliveryAt: string | null
  /** The provider's reason or the report's status code, bounded. */
  deliveryDetail: string | null
}

/** The latest delivery event about a reply that Maane could not tie to one recipient's send, as it was received. */
export interface UnmatchedDelivery {
  source: DeliverySource
  /** When Maane recorded it. */
  recordedAt: string
  status: DeliveryStatus | null
  /** The event's own time. */
  at: string | null
  recipient: string | null
  /** The Message-ID the event named (Maane's own, of this reply). */
  messageId: string | null
}

/** Where an outgoing message is. */
export interface DeliveryView {
  state: OutboxState
  problem: SendProblem | null
  recipients: RecipientView[]
  /**
   * A delivery event about this reply could not be tied to one recipient's send (plan 3.3): a report that names no
   * recipient accepted before it arrived, or an SMTP2GO event without a known queue ID for a recipient more than one
   * attempt could have reached.
   */
  unmatchedDelivery: UnmatchedDelivery | null
  /**
   * A scheduled reply that ended before it went out (plan 4.2): cancelled, changed, or stopped by a check at the send
   * point. It is never sent again; the agent can write a new reply.
   */
  scheduledEnded: boolean
  /** An automatic reminder (plan 4.3). */
  reminder: boolean
  /**
   * An automatic reminder that Send again may send again: no provider accepted it (never one with an unknown fate), and
   * its waiting period still holds. Any other reminder is never sent again.
   */
  reminderResend: boolean
}

/** What the composer of a ticket starts from. */
export interface ComposeView {
  /** The addresses the reply may come from: the organization's exact support addresses and the ticket's own. */
  from: string[]
  /** The ticket's own support address, when it still belongs to the organization; else the first of `from`. */
  defaultFrom: string | null
  /** The first participant, and the others. */
  to: MailAddress[]
  cc: MailAddress[]
  /** The organization's signature, added after the reply. */
  signature: string
  /** How the From line names the sender: `Agent Name (Organization Name)`. */
  senderName: string
}

/** What the composer submits. */
export interface ReplyInput {
  /** New for each click of Send; the same again only when the same request is repeated. */
  submissionId: string
  kind: "reply" | "note"
  from: string | null
  to: MailAddress[]
  cc: MailAddress[]
  /** The editor's HTML. */
  html: string
  /** The user's own uploads. */
  uploads: string[]
  /** Attachments and inline parts of the ticket's own messages. */
  parts: string[]
  /**
   * A reply only: set the ticket to pending in the same transaction (plan 4.1). The composer sends true by default
   * ("Send and set pending"); false or absent leaves the status as it is. A note never changes the status.
   */
  setPending?: boolean
  /**
   * A reply only: send it at this instant instead of now (plan 4.2), as an ISO time with its offset. The composer enters
   * it in Israel time; the server refuses a time that is not in the future.
   */
  sendAt?: string
}

/**
 * Where a timed action is (plan 4.2, one rule for every timed action):
 * - `scheduled`: waiting for its time; the agent can still change or cancel it.
 * - `handed`: its time came and its outbox row was made; the send point checks it once more before `sending`.
 * - `done`: it passed that check and went to the send point; the reply's own state says the rest.
 * - `cancelled`: by the agent, by a customer reply, or by a move to another organization (ACTION_REASONS).
 * - `ended`: a check at its time failed, so nothing was sent (the reason says which).
 */
export const ACTION_STATES = ["scheduled", "handed", "done", "cancelled", "ended"] as const
export type ActionState = (typeof ACTION_STATES)[number]

/**
 * Why a timed action was cancelled or ended: the agent cancelled it, the customer wrote (`customer_reply`), the ticket
 * moved to another organization (`move`), or a check at its time failed (the From address or the author is no longer
 * allowed). A reminder (plan 4.3) also ends with its waiting period: the ticket left pending
 * (`status_change`), an agent replied again (`agent_reply`), the reply that started the period bounced, was rejected, or
 * was reported as spam (`delivery_failed`); or at its time the organization has no reminder template (`no_template`)
 * or the ticket has no customer to write to (`no_recipients`).
 */
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

/** Why a waiting period ended (plan 4.3); its reminder, if it had not gone yet, never goes. */
export const PERIOD_END_REASONS = ["customer_reply", "status_change", "agent_reply", "move", "delivery_failed"] as const
export type PeriodEndReason = (typeof PERIOD_END_REASONS)[number]

/** The longest reminder template an organization keeps, in characters (as a signature). */
export const REMINDER_TEMPLATE_MAX = 2000
/** The bounds of the days a ticket waits for the customer before its reminder (the default is the column's, three). */
export const REMINDER_DAYS_MIN = 1
export const REMINDER_DAYS_MAX = 60

/** A ticket's reminder that has not gone yet (plan 4.3), for the ticket view: when it goes. */
export interface ReminderView {
  id: string
  /** When it goes, as an instant. */
  dueAt: string
  /** `scheduled`, or `handed`: written and waiting for the send point. */
  state: ActionState
}

/** A file of a scheduled reply: one of the agent's uploads, or a file of the ticket's own messages. */
export interface ScheduledFile {
  source: "upload" | "part"
  id: string
  fileName: string
  size: number
}

/** A scheduled reply in the ticket view (plan 4.2): its current version, its time, and where it is. */
export interface ScheduledReplyView {
  id: string
  /** Each change makes a new version; a change names the version it changes. */
  version: number
  state: ActionState
  reason: ActionReason | null
  /** When it goes, as an instant. */
  sendAt: string
  createdAt: string
  updatedAt: string
  author: { id: string; name: string } | null
  /** Only its author changes it (the files are their own uploads); anyone who sees the ticket may cancel it. */
  editable: boolean
  from: string
  to: MailAddress[]
  cc: MailAddress[]
  /** The text as it will be sent (the signature included), for reading. */
  text: string
  /** What the agent wrote, for the composer to change. */
  html: string
  setPending: boolean
  files: ScheduledFile[]
  /** Once its time came: the reply it made, and that reply's state. */
  messageId: string | null
  outboxState: OutboxState | null
}

/** A change of a scheduled reply: everything again, its new time, and the version it changes. */
export interface ScheduledInput extends Omit<ReplyInput, "submissionId" | "kind" | "sendAt"> {
  sendAt: string
  version: number
}

/**
 * Why an SMTP connection test failed: a setting is missing (`not_configured`), no connection or a timeout
 * (`connection`), TLS could not be set up (`tls`), the server refused the user or the password (`auth`), or anything
 * else (`error`).
 */
export const SMTP_PROBLEMS = ["not_configured", "connection", "tls", "auth", "error"] as const
export type SmtpProblem = (typeof SMTP_PROBLEMS)[number]

/** The result of an SMTP connection test (nodemailer's transporter.verify(), run by the worker). */
export interface SmtpTestResult {
  provider: Provider
  ok: boolean
  problem: SmtpProblem | null
  /** Nodemailer's error code (`EAUTH`, `ECONNECTION`, `ETLS`, ...), when there is one. */
  code: string | null
  /** The server's reply to the step that failed, bounded. */
  response: string | null
  checkedAt: string
}

/** A connection test the Settings page queued: where the worker is with it, and its result once done. */
export interface SmtpTestView {
  state: "queued" | "running" | "done" | "failed"
  result: SmtpTestResult | null
}
