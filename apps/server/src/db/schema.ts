import { sql } from "drizzle-orm"
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

const at = (name: string) => timestamp(name, { withTimezone: true })
const createdAt = () => at("created_at").notNull().defaultNow()

// --- Better Auth (core, username, twoFactor, admin), in the shape its Drizzle adapter documents ---

export const authUser = pgTable(
  "auth_user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Better Auth requires an e-mail: Maane derives `<username>@maane.invalid`. */
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    username: text("username").unique(),
    displayUsername: text("display_username"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false),
    /** `admin` or `agent` (admin plugin). */
    role: text("role"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: at("ban_expires"),
    /** The first admin, made by the setup screen (an additional field Maane declares to Better Auth). */
    setupAdmin: boolean("setup_admin").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  // One setup admin, ever: of two setup sign-ups that pass the checks together, the second fails at insert and its
  // transaction rolls back.
  (t) => [uniqueIndex("auth_user_one_setup_admin").on(sql`(true)`).where(sql`${t.setupAdmin}`)],
)

export const authSession = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: at("expires_at").notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: createdAt(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [index("auth_session_user_idx").on(t.userId)],
)

export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: at("access_token_expires_at"),
    refreshTokenExpiresAt: at("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [index("auth_account_user_idx").on(t.userId)],
)

export const authVerification = pgTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: at("expires_at").notNull(),
  createdAt: createdAt(),
  updatedAt: at("updated_at").notNull().defaultNow(),
})

export const authTwoFactor = pgTable(
  "auth_two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: at("locked_until"),
  },
  (t) => [index("auth_two_factor_secret_idx").on(t.secret), index("auth_two_factor_user_idx").on(t.userId)],
)

export const authRateLimit = pgTable("auth_rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
})

// --- Maane ---

/** One row per setting the owner changed. A plain value in `value`; a secret only as `ciphertext`. */
export const setting = pgTable(
  "setting",
  {
    key: text("key").primaryKey(),
    value: jsonb("value"),
    ciphertext: text("ciphertext"),
    updatedAt: at("updated_at").notNull().defaultNow(),
    updatedBy: text("updated_by"),
  },
  (t) => [check("setting_one_form", sql`(${t.value} is null) <> (${t.ciphertext} is null)`)],
)

/** Every sensitive action. Never a secret value. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: at("at").notNull().defaultNow(),
    /** The user who acted, or null for the system (the worker, a job). Users are never deleted, only banned. */
    actorUserId: text("actor_user_id").references(() => authUser.id, { onDelete: "set null" }),
    /** The username at the time, or `system`. */
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    details: jsonb("details"),
    ipAddress: text("ip_address"),
  },
  (t) => [index("audit_log_at_idx").on(t.at), index("audit_log_actor_idx").on(t.actorUserId)],
)

// --- Organizations, membership, support addresses (phase 2.1) ---
// Maane's own tables, not Better Auth's organization plugin (owner's decision, 2026-11-12): an admin sees every
// organization by role, and an agent sees the organizations of their membership rows.

/** An organization Maane answers for. Deleted only while nothing refers to it (the foreign keys below restrict it). */
export const organization = pgTable(
  "organization",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Trimmed, 1 to 80 characters, unique without regard to case. */
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("organization_name_unique").on(sql`lower(${t.name})`),
    check("organization_name_form", sql`${t.name} = btrim(${t.name}) and char_length(${t.name}) between 1 and 80`),
  ],
)

/** An agent's membership. Admins are never rows here: they see every organization by their role. */
export const organizationMember = pgTable(
  "organization_member",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId] }), index("organization_member_user_idx").on(t.userId)],
)

/**
 * An exact address or a pattern (`@maane/shared` addresses.ts) and its organization. A row's value, kind, and
 * organization are never changed: the admin adds a new row and removes the old one. Only the default mark moves.
 * Tickets keep the concrete address and the organization, never this row, so removing a row changes no ticket.
 */
export const supportAddress = pgTable(
  "support_address",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    /** `exact` or `pattern`. */
    kind: text("kind").notNull(),
    /** In lower case; unique across every organization. */
    value: text("value").notNull().unique(),
    /** The address for mail whose support address cannot be identified: at most one, and always exact. */
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("support_address_organization_idx").on(t.organizationId),
    uniqueIndex("support_address_one_default").on(sql`(true)`).where(sql`${t.isDefault}`),
    check("support_address_kind", sql`${t.kind} in ('exact', 'pattern')`),
    check("support_address_lower_case", sql`${t.value} = lower(${t.value})`),
    check("support_address_default_exact", sql`not ${t.isDefault} or ${t.kind} = 'exact'`),
  ],
)

// --- Files and scanning (phase 2.2) ---

/**
 * One file in the content-addressed store, under <files dir>/<first two hex>/<sha256>. Only content that scanned
 * clean, not fully scanned, or not scanned (the scanner was unavailable and the policy allows) is ever stored;
 * infected, blocked, and waiting content never reaches the disk. The file is written, synced, and renamed into place
 * in the transaction that inserts this row, under a transaction-scoped advisory lock on the hash, so the daily sweep
 * of files no row references never interleaves with a writer of the same hash. A file is reached only through its
 * attachment, message, and ticket (from phase 2.3), never by its hash.
 */
export const storedFile = pgTable(
  "stored_file",
  {
    sha256: text("sha256").primaryKey(),
    size: bigint("size", { mode: "number" }).notNull(),
    /** The type read from the content (file-type), `text/plain` by the text rule, or `application/octet-stream`. */
    detectedType: text("detected_type").notNull(),
    /** `clean`, `not_fully_scanned`, or `not_scanned`. */
    scanStatus: text("scan_status").notNull(),
    /** The scanner's alert for a file not fully scanned (for example `Heuristics.Encrypted.Zip`). */
    signature: text("signature"),
    /** When a scanner decided; null for a file stored not scanned. */
    scannedAt: at("scanned_at"),
    createdAt: createdAt(),
  },
  (t) => [
    check("stored_file_sha256", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("stored_file_size", sql`${t.size} >= 0`),
    check("stored_file_status", sql`${t.scanStatus} in ('clean', 'not_fully_scanned', 'not_scanned')`),
  ],
)

/**
 * The latest self-test of the scanner, one row. `clean` is trusted only from the address this row names, while it
 * passed. The worker writes it on start, every hour, when the address changes, and for a connection test.
 */
export const scannerCheck = pgTable(
  "scanner_check",
  {
    id: integer("id").primaryKey(),
    address: text("address").notNull(),
    ok: boolean("ok").notNull(),
    /** The first check that failed (`@maane/shared` SCANNER_CHECKS). */
    failedCheck: text("failed_check"),
    version: text("version"),
    checkedAt: at("checked_at").notNull(),
  },
  (t) => [check("scanner_check_one_row", sql`${t.id} = 1`)],
)

// --- Graph intake, messages, tickets (phase 2.3) ---

/**
 * One pair of Entra tenant and intake mailbox. Changing either makes another row current; the old row, its cursors,
 * and its messages stay, read-only. At most one row is current. A transaction that stores newly fetched messages or a
 * cursor locks the row FOR SHARE and commits only while it is still current; a settings change locks the current row
 * FOR UPDATE, so a change during a slow fetch makes that fetch's store roll back.
 */
export const intakeSource = pgTable(
  "intake_source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** In lower case. */
    tenantId: text("tenant_id").notNull(),
    /** In lower case. */
    mailbox: text("mailbox").notNull(),
    current: boolean("current").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("intake_source_pair").on(t.tenantId, t.mailbox),
    uniqueIndex("intake_source_one_current").on(sql`(true)`).where(sql`${t.current}`),
    check("intake_source_lower_case", sql`${t.tenantId} = lower(${t.tenantId}) and ${t.mailbox} = lower(${t.mailbox})`),
  ],
)

/**
 * Where a folder's delta query of one source goes on: the `nextLink` of the next page, or the `deltaLink` of the next
 * round. Written only after the page's messages are committed.
 */
export const intakeCursor = pgTable(
  "intake_cursor",
  {
    sourceId: uuid("source_id")
      .notNull()
      .references(() => intakeSource.id, { onDelete: "restrict" }),
    /** A well-known folder (`@maane/shared` GRAPH_FOLDERS). */
    folder: text("folder").notNull(),
    link: text("link").notNull(),
    /** `next` (a page of the round in progress) or `delta` (the round is done). */
    kind: text("kind").notNull(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.folder] }),
    check("intake_cursor_folder", sql`${t.folder} in ('inbox', 'junkemail')`),
    check("intake_cursor_kind", sql`${t.kind} in ('next', 'delta')`),
  ],
)

/** Ticket numbers. The cutover (phase 6) sets the floor above the highest Zendesk number. */
export const ticketNumber = pgSequence("ticket_number_seq", { startWith: 1 })

/**
 * A ticket. Its support address and organization are the concrete ones of the message that opened it and never change
 * by a later message. The reference code is random (CSPRNG) over `@maane/shared` REFERENCE_ALPHABET.
 */
export const ticket = pgTable(
  "ticket",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: bigint("number", { mode: "number" }).notNull().unique().default(sql`nextval('ticket_number_seq')`),
    referenceCode: text("reference_code").notNull().unique(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    /** The concrete support address that matched (or the default address), in lower case. */
    supportAddress: text("support_address").notNull(),
    subject: text("subject"),
    /** `@maane/shared` TICKET_STATUSES. */
    status: text("status").notNull().default("new"),
    /** `@maane/shared` TICKET_FLAGS. */
    reviewFlags: text("review_flags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    lastActivityAt: at("last_activity_at").notNull().defaultNow(),
  },
  (t) => [
    index("ticket_organization_idx").on(t.organizationId),
    check("ticket_status", sql`${t.status} in ('new', 'open')`),
    check(
      "ticket_reference_code",
      sql`${t.referenceCode} ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$'`,
    ),
  ],
)

/** The people of a ticket: the sender of the message that opened it and the `Cc` addresses that are not support addresses. */
export const ticketParticipant = pgTable(
  "ticket_participant",
  {
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "restrict" }),
    /** In lower case. */
    address: text("address").notNull(),
    name: text("name"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.address] })],
)

/** A ticket opened beside others it matched: the sender was not a participant, or a late original was ambiguous. */
export const ticketLink = pgTable(
  "ticket_link",
  {
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "restrict" }),
    linkedTicketId: uuid("linked_ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "restrict" }),
    /** `sender_not_participant` or `ambiguous_original` (`@maane/shared` TICKET_FLAGS). */
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.ticketId, t.linkedTicketId] }),
    index("ticket_link_linked_idx").on(t.linkedTicketId),
  ],
)

/**
 * One message as Graph delivered it. Stage one stores it (`stored`) with its parts, the files that may be kept, and
 * its raw MIME only when the raw message and every part scanned clean; stage two processes it once (`processed`).
 * Every text is well formed (U+0000 and unpaired surrogates replaced by U+FFFD, flagged for review); the HTML is the
 * sanitized HTML, never the sender's.
 */
export const message = pgTable(
  "message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => intakeSource.id, { onDelete: "restrict" }),
    /** Graph's immutable ID. */
    graphId: text("graph_id").notNull(),
    folder: text("folder").notNull(),
    /** Graph's receivedDateTime: processing goes oldest first by it. */
    receivedAt: at("received_at").notNull(),
    /** `@maane/shared` MESSAGE_STATES. */
    state: text("state").notNull().default("stored"),
    /** `@maane/shared` MESSAGE_CONTENTS. */
    content: text("content").notNull(),
    /** What Graph said about it in the delta query (subject, sender, Message-ID, times). */
    graph: jsonb("graph").notNull(),
    /** The size of the raw MIME in bytes, when it was read. */
    size: bigint("size", { mode: "number" }),
    /** Message-ID without its angle brackets. */
    messageIdHeader: text("message_id_header"),
    inReplyTo: text("in_reply_to").array().notNull().default(sql`'{}'::text[]`),
    references: text("references").array().notNull().default(sql`'{}'::text[]`),
    /** In lower case. */
    fromAddress: text("from_address"),
    fromName: text("from_name"),
    /** `{ address, name }[]`, addresses in lower case. */
    toAddresses: jsonb("to_addresses").notNull().default(sql`'[]'::jsonb`),
    ccAddresses: jsonb("cc_addresses").notNull().default(sql`'[]'::jsonb`),
    /** The Date header. */
    sentAt: at("sent_at"),
    subject: text("subject"),
    /** Every header line as received (`{ key, line }[]`). */
    headers: jsonb("headers").notNull().default(sql`'[]'::jsonb`),
    textBody: text("text_body"),
    /** The HTML after sanitize-html, before it was stored. */
    htmlBody: text("html_body"),
    /** SHA-256 of the decoded text, HTML, and every part's hash: with the Message-ID, From, and Date, a copy's key. */
    contentHash: text("content_hash"),
    /** The scan status of the raw message. */
    rawStatus: text("raw_status"),
    /** The raw MIME, kept only when it and every part scanned clean. */
    rawSha256: text("raw_sha256").references(() => storedFile.sha256, { onDelete: "restrict" }),
    /** A delivery or disposition report's original Message-ID, for phase 3 to link to the outgoing message. */
    reportOriginalMessageId: text("report_original_message_id"),
    /** The top-level content type as mailparser parsed it, bounded: `{ value, reportType }`. */
    contentType: jsonb("content_type"),
    /**
     * The scan of each stored text field (`text`, `html`, `headers`: the header values Maane keeps), as
     * `{ status, signature, blockedBy }`. A field that scanned infected or blocked is not stored; one that waits for
     * the scanner is stored once a retry decides; processing waits while a field waits.
     */
    fieldScans: jsonb("field_scans").notNull().default(sql`'{}'::jsonb`),
    /** Listening: the shadow conversation the message belongs to (live mode uses tickets). */
    conversationId: uuid("conversation_id").references(() => intakeConversation.id, { onDelete: "restrict" }),
    /**
     * Listening: the existing ticket the message would have joined (review G4). The ticket itself is not changed; later
     * listening replies to this message match that ticket too.
     */
    wouldTicketId: uuid("would_ticket_id").references(() => ticket.id, { onDelete: "restrict" }),
    /** From MAILER-DAEMON or postmaster without a sign of automated mail (classified at stage one, review G13). */
    possiblyAutomated: boolean("possibly_automated").notNull().default(false),
    /** Processing runs that failed on this message; after a few it is recorded for review instead. */
    processAttempts: integer("process_attempts").notNull().default(0),
    /** Fetches of this message again for what waits for the scanner, and the last one. */
    retryAttempts: integer("retry_attempts").notNull().default(0),
    retryAt: at("retry_at"),
    /** `@maane/shared` MESSAGE_FLAGS. */
    reviewFlags: text("review_flags").array().notNull().default(sql`'{}'::text[]`),
    /** `customer` or `automated`, classified at stage one from the parsed headers, before any is dropped. */
    classification: text("classification"),
    automatedReasons: text("automated_reasons").array().notNull().default(sql`'{}'::text[]`),
    ticketId: uuid("ticket_id").references(() => ticket.id, { onDelete: "restrict" }),
    /** The earlier message this one is a copy of. */
    duplicateOf: uuid("duplicate_of"),
    processedAt: at("processed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("message_source_graph").on(t.sourceId, t.graphId),
    index("message_state_received_idx").on(t.state, t.receivedAt),
    index("message_message_id_idx").on(t.messageIdHeader),
    index("message_ticket_idx").on(t.ticketId),
    check("message_state", sql`${t.state} in ('stored', 'processed')`),
    check("message_content", sql`${t.content} in ('parsed', 'unavailable', 'unparsed', 'too_large')`),
    check("message_folder", sql`${t.folder} in ('inbox', 'junkemail')`),
  ],
)

/**
 * An attachment or inline part of a message, with its scan status. Its content is in the store (`stored_sha256`) only
 * when its status allows it; infected, blocked, and waiting content never is.
 */
export const messagePart = pgTable(
  "message_part",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "restrict" }),
    /** The part's position among the message's attachments, as mailparser lists them. */
    index: integer("index").notNull(),
    /** `attachment` or `inline`. */
    kind: text("kind").notNull(),
    fileName: text("file_name"),
    declaredType: text("declared_type"),
    contentId: text("content_id"),
    size: bigint("size", { mode: "number" }).notNull(),
    /** SHA-256 of the decoded content, also when it is not stored. */
    sha256: text("sha256").notNull(),
    /** `@maane/shared` PART_STATUSES. */
    status: text("status").notNull(),
    signature: text("signature"),
    /** The blocked list entry that matched (`blocked_type`). */
    blockedBy: text("blocked_by"),
    storedSha256: text("stored_sha256").references(() => storedFile.sha256, { onDelete: "restrict" }),
    /** Why a waiting part became unavailable (Graph's status when it was fetched again). */
    unavailableReason: text("unavailable_reason"),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("message_part_position").on(t.messageId, t.index),
    index("message_part_status_idx").on(t.status),
    check("message_part_kind", sql`${t.kind} in ('attachment', 'inline')`),
    check(
      "message_part_status",
      sql`${t.status} in ('clean', 'infected', 'not_fully_scanned', 'blocked_type', 'waiting', 'not_scanned', 'unavailable', 'too_large')`,
    ),
    check(
      "message_part_stored",
      sql`${t.storedSha256} is null or ${t.status} in ('clean', 'not_fully_scanned', 'not_scanned')`,
    ),
  ],
)

/**
 * A `Message-ID` a ticket's message referred to that was not stored yet. A later message naming it, or the original
 * itself, finds the ticket through it; `resolved_by` is set once the original was processed.
 */
export const ticketPendingReference = pgTable(
  "ticket_pending_reference",
  {
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "restrict" }),
    messageIdHeader: text("message_id_header").notNull(),
    resolvedBy: uuid("resolved_by").references(() => message.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.ticketId, t.messageIdHeader] }),
    index("ticket_pending_reference_message_id_idx").on(t.messageIdHeader),
  ],
)

/**
 * What processing did with a message (live) or would have done (listening): one row per processed message. In
 * listening mode no ticket exists and `ticket_id` stays null; the ticket or message it would have matched is kept.
 */
export const intakeRecord = pgTable(
  "intake_record",
  {
    messageId: uuid("message_id")
      .primaryKey()
      .references(() => message.id, { onDelete: "restrict" }),
    /** The intake mode the processing read. */
    mode: text("mode").notNull(),
    /** `@maane/shared` INTAKE_OUTCOMES. */
    outcome: text("outcome").notNull(),
    classification: text("classification"),
    /** The concrete support address and its organization (or the default's). */
    supportAddress: text("support_address"),
    organizationId: uuid("organization_id").references(() => organization.id, { onDelete: "restrict" }),
    /** Live: the ticket the message opened or joined. */
    ticketId: uuid("ticket_id").references(() => ticket.id, { onDelete: "restrict" }),
    /** The ticket it matched (live) or would have matched (listening). */
    matchedTicketId: uuid("matched_ticket_id").references(() => ticket.id, { onDelete: "restrict" }),
    /** Listening: the earlier message whose conversation it would have joined (unused since conversations). */
    matchedMessageId: uuid("matched_message_id").references(() => message.id, { onDelete: "restrict" }),
    /** Listening: the shadow conversation the message opened or joined. */
    conversationId: uuid("conversation_id").references(() => intakeConversation.id, { onDelete: "restrict" }),
    /** Listening: the conversation it matched. */
    matchedConversationId: uuid("matched_conversation_id").references(() => intakeConversation.id, {
      onDelete: "restrict",
    }),
    /** `@maane/shared` MATCH_LAYERS. */
    matchLayer: text("match_layer"),
    /** A short reason in the code's words (`sender_not_participant`, `auto_submitted`, ...). */
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("intake_record_created_idx").on(t.createdAt),
    check("intake_record_mode", sql`${t.mode} in ('listening', 'live')`),
    check(
      "intake_record_outcome",
      sql`${t.outcome} in ('copy', 'automated', 'unreadable', 'no_address', 'new_ticket', 'joined', 'new_linked_ticket')`,
    ),
  ],
)

/**
 * Listening mode's shadow of a ticket: no number, no reference code, no status. Processing keeps it with the same code
 * path as tickets (participants, links, pending references), so a listening record says exactly what live mode would
 * have decided.
 */
export const intakeConversation = pgTable(
  "intake_conversation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    supportAddress: text("support_address").notNull(),
    /** `@maane/shared` TICKET_FLAGS. */
    reviewFlags: text("review_flags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [index("intake_conversation_organization_idx").on(t.organizationId)],
)

export const intakeConversationParticipant = pgTable(
  "intake_conversation_participant",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => intakeConversation.id, { onDelete: "restrict" }),
    address: text("address").notNull(),
    name: text("name"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.address] })],
)

export const intakeConversationLink = pgTable(
  "intake_conversation_link",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => intakeConversation.id, { onDelete: "restrict" }),
    linkedConversationId: uuid("linked_conversation_id")
      .notNull()
      .references(() => intakeConversation.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.linkedConversationId] })],
)

export const intakeConversationPending = pgTable(
  "intake_conversation_pending",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => intakeConversation.id, { onDelete: "restrict" }),
    messageIdHeader: text("message_id_header").notNull(),
    resolvedBy: uuid("resolved_by").references(() => message.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.messageIdHeader] }),
    index("intake_conversation_pending_message_id_idx").on(t.messageIdHeader),
  ],
)

/**
 * Listening mode's pending references owned by an existing ticket (review G4): a listening message that would join a
 * ticket and refers to a missing original keeps the reference here, never in the ticket's own pending references, so
 * a later listening message naming it, or the late original, would join that ticket as live mode would.
 */
export const intakeTicketPending = pgTable(
  "intake_ticket_pending",
  {
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "restrict" }),
    messageIdHeader: text("message_id_header").notNull(),
    resolvedBy: uuid("resolved_by").references(() => message.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.ticketId, t.messageIdHeader] }),
    index("intake_ticket_pending_message_id_idx").on(t.messageIdHeader),
  ],
)

/** A listening conversation opened beside existing tickets it matched (review G17): every candidate ticket is kept. */
export const intakeConversationTicketLink = pgTable(
  "intake_conversation_ticket_link",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => intakeConversation.id, { onDelete: "restrict" }),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "restrict" }),
    /** `sender_not_participant` or `ambiguous_original`. */
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.ticketId] })],
)
