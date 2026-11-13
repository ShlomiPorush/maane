// The words of replies that send (plan 3.1) that the server, the worker, and the UI share: message directions, the
// states of an outgoing message and of each recipient, why a send did not happen, uploads, and the shapes the composer
// and the ticket view use.

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
 * - `listening`: intake listens, so Maane answers no customer (the send point refuses).
 * - `from_not_allowed`: the From address no longer belongs to the ticket's organization.
 * - `author_not_allowed`: the author may no longer answer this ticket (removed, disabled, or out of its organization).
 * - `not_configured`: neither SMTP2GO nor the failover server is set up.
 * - `unreachable`: no provider could be reached or logged in to, so nothing was sent.
 */
export const SEND_PROBLEMS = [
  "listening",
  "from_not_allowed",
  "author_not_allowed",
  "not_configured",
  "unreachable",
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
/** The most files one reply may carry. */
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
}

/** Where an outgoing message is. */
export interface DeliveryView {
  state: OutboxState
  problem: SendProblem | null
  recipients: RecipientView[]
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
  /** Intake listens: Maane sends no reply; internal notes are still written. */
  listening: boolean
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
