// The words of Graph intake (plan 2.3) that the server, the worker, and the UI share: the folders Maane reads, the
// states of a stored message, the review flags, the ticket statuses, the reference code, the outcomes of processing,
// and the result of the Graph connection test.

import { parseExactAddress } from "./addresses.ts"
import { SCAN_STATUSES } from "./files.ts"

/** The well-known folders the worker reads with delta queries, each with its own cursor per intake source. */
export const GRAPH_FOLDERS = ["inbox", "junkemail"] as const
export type GraphFolder = (typeof GRAPH_FOLDERS)[number]

/** Stage one stores a message as `stored`; stage two processes it once and marks it `processed`. */
export const MESSAGE_STATES = ["stored", "processed"] as const
export type MessageState = (typeof MESSAGE_STATES)[number]

/**
 * What stage one could take in: the parsed message (`parsed`), or a record with only its Graph metadata because the
 * message vanished before its content was read (`unavailable`), could not be parsed (`unparsed`), or was larger than
 * files.maxBytes (`too_large`). Only a parsed message can open or join a ticket.
 */
export const MESSAGE_CONTENTS = ["parsed", "unavailable", "unparsed", "too_large"] as const
export type MessageContent = (typeof MESSAGE_CONTENTS)[number]

/** A part's status: the file statuses of plan 2.2, and `too_large` for a part over files.maxBytes (never scanned). */
export const PART_STATUSES = [...SCAN_STATUSES, "too_large"] as const
export type PartStatus = (typeof PART_STATUSES)[number]

/**
 * Why a message needs a person's look:
 * - `unavailable`, `parse_failed`, `too_large`: stage one kept only the Graph metadata.
 * - `invalid_characters`: a decoded text held U+0000 or an unpaired surrogate, replaced by U+FFFD before storing.
 * - `reused_message_id`: another message has the same Message-ID with other content.
 * - `no_default_address`: no support address matched and no default exists, so it opened no ticket.
 * - `part_too_large`: a part was over files.maxBytes and was not scanned or kept.
 */
export const MESSAGE_FLAGS = [
  "unavailable",
  "parse_failed",
  "too_large",
  "invalid_characters",
  "reused_message_id",
  "no_default_address",
  "part_too_large",
] as const
export type MessageFlag = (typeof MESSAGE_FLAGS)[number]

/**
 * Why a ticket needs a person's look:
 * - `possibly_automated`: from MAILER-DAEMON or postmaster with none of the signs of automated mail.
 * - `sender_not_participant`: a reply matched a ticket whose participants do not include its sender; this new ticket
 *   is linked to that one.
 * - `ambiguous_original`: a late original that more than one ticket was waiting for; this new ticket is linked to
 *   each of them.
 */
export const TICKET_FLAGS = ["possibly_automated", "sender_not_participant", "ambiguous_original"] as const
export type TicketFlag = (typeof TICKET_FLAGS)[number]

/** A new ticket is `new`; a customer message on an existing ticket makes it `open`. Later phases add the rest. */
export const TICKET_STATUSES = ["new", "open"] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

/**
 * What processing did with a message (live) or would have done (listening):
 * - `copy`: a copy of an earlier message (Message-ID, From, Date, and content all equal); nothing else changes.
 * - `automated`: automated mail; it never opens, joins, or reopens a ticket.
 * - `unreadable`: only Graph metadata was kept (see MESSAGE_CONTENTS).
 * - `no_address`: it needed a new ticket, but no support address matched and no default exists.
 * - `new_ticket`, `joined`: a new ticket, or a ticket it matched and whose participant sent it.
 * - `new_linked_ticket`: a new ticket linked to the ticket or tickets it matched (sender not a participant, or a late
 *   original several tickets wait for).
 */
export const INTAKE_OUTCOMES = [
  "copy",
  "automated",
  "unreadable",
  "no_address",
  "new_ticket",
  "joined",
  "new_linked_ticket",
] as const
export type IntakeOutcome = (typeof INTAKE_OUTCOMES)[number]

/** The threading layer that matched: the headers, a late original's pending reference, the body code, the subject. */
export const MATCH_LAYERS = ["header", "original", "reference", "subject"] as const
export type MatchLayer = (typeof MATCH_LAYERS)[number]

/**
 * The alphabet of the ticket reference code (`XXXX-XXXX`): capital letters and digits without the look-alikes 0, O, 1,
 * I, and L. 31 symbols, so a code holds about 39.6 random bits.
 */
export const REFERENCE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
export const REFERENCE_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const DOMAIN = /^(?=.{4,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/

/** An Entra tenant: its ID (a GUID) or one of its domain names (`example.onmicrosoft.com`). */
export const isTenantId = (text: string) => GUID.test(text) || DOMAIN.test(text)
/** An Entra application (client) ID: a GUID. */
export const isClientId = (text: string) => GUID.test(text)
/** The intake mailbox: one plain address. */
export const isMailbox = (text: string) => parseExactAddress(text).ok

/** Why a Graph connection test failed. */
export const GRAPH_PROBLEMS = [
  /** A tenant, application, secret, or mailbox is not set. */
  "not_configured",
  /** Entra refused the tenant, the application, or the secret. */
  "credential",
  /** Graph answered 401 or 403: the application may not read this mailbox. */
  "access_denied",
  /** Graph answered 404: no such mailbox or folder. */
  "not_found",
  /** Graph kept answering 429 after the retries. */
  "throttled",
  /** No answer: the network, a timeout, or a refused connection. */
  "network",
  /** Any other answer. */
  "error",
] as const
export type GraphProblem = (typeof GRAPH_PROBLEMS)[number]

/** The result of the Graph connection test: the Inbox folder's metadata was read, or why not. */
export interface GraphTestResult {
  ok: boolean
  problem: GraphProblem | null
  /** The code Entra or Graph gave (`invalid_client`, `AADSTS7000215`, `ErrorAccessDenied`), when it gave one. */
  code: string | null
  /** Graph's HTTP status, when it answered. */
  status: number | null
  mailbox: string
  checkedAt: string
}

/** A connection test the Settings page queued: where the worker is with it, and its result once done. */
export interface GraphTestView {
  state: "queued" | "running" | "done" | "failed"
  result: GraphTestResult | null
}
