import { parseExactAddress } from "./addresses.ts"
import { SCAN_STATUSES } from "./files.ts"

export const GRAPH_FOLDERS = ["inbox", "junkemail"] as const
export type GraphFolder = (typeof GRAPH_FOLDERS)[number]

export const MESSAGE_STATES = ["stored", "processed"] as const
export type MessageState = (typeof MESSAGE_STATES)[number]

export const MESSAGE_CONTENTS = ["parsed", "unavailable", "unparsed", "too_large"] as const
export type MessageContent = (typeof MESSAGE_CONTENTS)[number]

export const PART_STATUSES = [...SCAN_STATUSES, "too_large"] as const
export type PartStatus = (typeof PART_STATUSES)[number]

export const MESSAGE_FLAGS = [
  "unavailable",
  "not_read",
  "parse_failed",
  "too_large",
  "invalid_characters",
  "reused_message_id",
  "part_too_large",
  "store_failed",
  "blocked_content",
] as const
export type MessageFlag = (typeof MESSAGE_FLAGS)[number]

export const TICKET_FLAGS = [
  "possibly_automated",
  "sender_not_participant",
  "ambiguous_original",
  "delivery_failed",
  "possible_duplicate",
] as const
export type TicketFlag = (typeof TICKET_FLAGS)[number]

export const TICKET_STATUSES = ["new", "open", "pending", "on_hold", "solved", "closed"] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export const LINK_REASONS = ["sender_not_participant", "ambiguous_original", "follow_up", "merged"] as const
export type LinkReason = (typeof LINK_REASONS)[number]

export const INTAKE_OUTCOMES = ["copy", "automated", "unreadable", "new_ticket", "joined", "new_linked_ticket"] as const
export type IntakeOutcome = (typeof INTAKE_OUTCOMES)[number]

export const AUTOMATED_SIGNS = [
  "auto_submitted",
  "delivery_report",
  "disposition_report",
  "precedence",
  "list",
  "autoreply_header",
] as const
export type AutomatedSign = (typeof AUTOMATED_SIGNS)[number]

export const INTAKE_REASONS = [
  "copy",
  "sent_by_maane",
  "process_failed",
  "unavailable",
  "not_read",
  "unparsed",
  "too_large",
  "sender_not_participant",
  "ambiguous_original",
  "follow_up",
  ...AUTOMATED_SIGNS,
] as const
export type IntakeReason = (typeof INTAKE_REASONS)[number]

export const MATCH_LAYERS = ["header", "original", "reference", "subject"] as const
export type MatchLayer = (typeof MATCH_LAYERS)[number]

export const REFERENCE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
export const REFERENCE_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const DOMAIN = /^(?=.{4,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/

export const isTenantId = (text: string) => GUID.test(text) || DOMAIN.test(text)
export const isClientId = (text: string) => GUID.test(text)
export const isMailbox = (text: string) => parseExactAddress(text).ok

export const GRAPH_PROBLEMS = [
  "not_configured",
  "credential",
  "access_denied",
  "not_found",
  "throttled",
  "network",
  "error",
] as const
export type GraphProblem = (typeof GRAPH_PROBLEMS)[number]

export interface GraphTestResult {
  ok: boolean
  problem: GraphProblem | null
  code: string | null
  status: number | null
  mailbox: string
  checkedAt: string
}

export interface GraphTestView {
  state: "queued" | "running" | "done" | "failed"
  result: GraphTestResult | null
}

export const TEXT_FIELDS = ["text", "html", "headers"] as const
export type TextField = (typeof TEXT_FIELDS)[number]

export interface FieldScan {
  status: PartStatus
  signature: string | null
  blockedBy: string | null
}
