import { sql } from "drizzle-orm"
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
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
/** Bytes, as Drizzle documents a column type it does not ship (customType). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" })
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
    /** Plain text at the end of every reply sent for this organization (phase 3.1); empty for none. */
    signature: text("signature").notNull().default(""),
    /**
     * The automatic reminder (plan 4.3): plain text, as the signature; empty sends no reminder for this organization.
     */
    reminderTemplate: text("reminder_template").notNull().default(""),
    /** The days a ticket waits for the customer before its reminder goes (`@maane/shared` REMINDER_DAYS_*). */
    reminderDays: integer("reminder_days").notNull().default(3),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("organization_name_unique").on(sql`lower(${t.name})`),
    check("organization_name_form", sql`${t.name} = btrim(${t.name}) and char_length(${t.name}) between 1 and 80`),
    check("organization_signature_length", sql`char_length(${t.signature}) <= 2000`),
    check("organization_reminder_template_length", sql`char_length(${t.reminderTemplate}) <= 2000`),
    check("organization_reminder_days", sql`${t.reminderDays} between 1 and 60`),
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
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.folder] }),
    check("intake_cursor_folder", sql`${t.folder} in ('inbox', 'junkemail')`),
  ],
)

/**
 * Ticket numbers. An imported ticket keeps its Zendesk number; after each import run the sequence continues right
 * after the highest ticket number, with no gap (owner's decision 1, 2026-11-16).
 */
export const ticketNumber = pgSequence("ticket_number_seq", { startWith: 1 })

/**
 * A ticket. Its support address and organization are the concrete ones of the message that opened it and never change
 * by a later message; only a move (plan 4.1) changes the organization, and the support address stays as it came. The
 * reference code is random (CSPRNG) over `@maane/shared` REFERENCE_ALPHABET.
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
    /**
     * Snoozed until this instant (plan 4.2): the ticket leaves the default list until then. Its `snooze-end` job ends
     * the snooze only once this time has come, so the job of a replaced snooze does nothing early.
     */
    snoozedUntil: at("snoozed_until"),
    /**
     * An imported ticket (plan 5.1): its Zendesk ticket ID, which is also its Maane number (owner's decision,
     * 2026-11-16). Null for a ticket Maane opened. An imported ticket is read-only for agents until an
     * admin presses Finish import.
     */
    zendeskId: bigint("zendesk_id", { mode: "number" }).unique(),
    /**
     * What the import keeps of the Zendesk ticket beside its own columns (`ImportedTicketSource` in
     * apps/server/src/imports/source.ts): the brand, the original tags, the custom fields with their names, the
     * followers (never recipients), and the merged and follow-up tickets it names.
     */
    zendesk: jsonb("zendesk"),
  },
  (t) => [
    index("ticket_organization_idx").on(t.organizationId),
    check("ticket_zendesk", sql`(${t.zendeskId} is null) = (${t.zendesk} is null)`),
    // Search (plan 4.4): ILIKE '%term%' through pg_trgm's documented GIN operator class.
    index("ticket_subject_trgm_idx").using("gin", t.subject.op("gin_trgm_ops")),
    check("ticket_status", sql`${t.status} in ('new', 'open', 'pending', 'on_hold', 'solved', 'closed')`),
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
  (t) => [
    primaryKey({ columns: [t.ticketId, t.address] }),
    // Search (plan 4.4): the customer's address and name.
    index("ticket_participant_address_trgm_idx").using("gin", t.address.op("gin_trgm_ops")),
    index("ticket_participant_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
  ],
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
    /** `@maane/shared` LINK_REASONS: `sender_not_participant`, `ambiguous_original`, or `follow_up` (plan 4.1). */
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.ticketId, t.linkedTicketId] }),
    index("ticket_link_linked_idx").on(t.linkedTicketId),
  ],
)

// --- Categories (plan 4.1) ---

/** One shared list of categories, managed by admins. Deleting one removes it from every ticket (on delete cascade). */
export const category = pgTable(
  "category",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Trimmed, 1 to 80 characters, unique without regard to case. */
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("category_name_unique").on(sql`lower(${t.name})`),
    check("category_name_form", sql`${t.name} = btrim(${t.name}) and char_length(${t.name}) between 1 and 80`),
  ],
)

/** A ticket's categories: any number of them. */
export const ticketCategory = pgTable(
  "ticket_category",
  {
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "restrict" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => category.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.categoryId] }), index("ticket_category_category_idx").on(t.categoryId)],
)

/**
 * One message of a ticket. Incoming (`in`): as Graph delivered it. Stage one stores it (`stored`) with its parts, the
 * files that may be kept, and its raw MIME only when the raw message and every part scanned clean; stage two processes
 * it once (`processed`). Every text is well formed (U+0000 and unpaired surrogates replaced by U+FFFD, flagged for
 * review); the HTML is the sanitized HTML, never the sender's. An agent's reply (`out`, with its outbox row) and an
 * internal note (`note`, never sent) are written processed, with their author and the submission ID of the composer
 * that sent them, and only the columns of intake that apply (phase 3.1).
 */
export const message = pgTable(
  "message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `@maane/shared` MESSAGE_DIRECTIONS: `in` from intake, `out` a reply, `note` an internal note. */
    direction: text("direction").notNull().default("in"),
    /** Incoming only: the intake source. */
    sourceId: uuid("source_id").references(() => intakeSource.id, { onDelete: "restrict" }),
    /** Graph's immutable ID (incoming only). */
    graphId: text("graph_id"),
    folder: text("folder"),
    /** Graph's receivedDateTime: processing goes oldest first by it. A reply or a note: when it was written. */
    receivedAt: at("received_at").notNull(),
    /** `@maane/shared` MESSAGE_STATES. */
    state: text("state").notNull().default("stored"),
    /** `@maane/shared` MESSAGE_CONTENTS. */
    content: text("content").notNull(),
    /** What Graph said about it in the delta query (subject, sender, Message-ID, times). Incoming only. */
    graph: jsonb("graph"),
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
    /**
     * A delivery status notification's recipients (RFC 3464), read at stage one: `{ address, action, status }[]`, only
     * validated tokens (an address, an action keyword, a status code), never the report's free text (plan 3.3).
     */
    deliveryReport: jsonb("delivery_report").$type<{ address: string; action: string; status: string | null }[]>(),
    /** The top-level content type as mailparser parsed it, bounded: `{ value, reportType }`. */
    contentType: jsonb("content_type"),
    /**
     * The scan of each stored text field (`text`, `html`, `headers`: the header values Maane keeps), as
     * `{ status, signature, blockedBy }`. A field that scanned infected or blocked is not stored; one that waits for
     * the scanner is stored once a retry decides; processing waits while a field waits.
     */
    fieldScans: jsonb("field_scans").notNull().default(sql`'{}'::jsonb`),
    /** From MAILER-DAEMON or postmaster without a sign of automated mail (classified at stage one, review G13). */
    possiblyAutomated: boolean("possibly_automated").notNull().default(false),
    /** Processing runs that failed on this message; after a few it is recorded for review instead. */
    processAttempts: integer("process_attempts").notNull().default(0),
    /** The last fetch of this message again for what waits for the scanner. */
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
    /** A reply or a note: the agent who wrote it. Users are never deleted, only banned. */
    authorUserId: text("author_user_id").references(() => authUser.id, { onDelete: "restrict" }),
    /** A reply or a note: the composer's ID for one click, so a repeated request finds this message again. */
    submissionId: uuid("submission_id"),
    /**
     * An imported comment (plan 5.1): its source key, `comment:<Zendesk comment ID>` or `side:<side conversation event
     * ID>`, unique, so a run again updates the same row. Null for every message Maane received or wrote.
     */
    zendeskKey: text("zendesk_key").unique(),
    /**
     * An imported comment's source (`ImportedMessageSource` in apps/server/src/imports/source.ts): its Zendesk IDs,
     * the author's name and role, and the email identifiers Zendesk recorded (Message-ID, the original sender and
     * recipients), or the explicit mark that it recorded none. Kept here only: the Message-ID never enters
     * `message_id_header`, so intake's threading and copies never see it.
     */
    zendesk: jsonb("zendesk"),
    /**
     * An imported comment's Message-ID as Zendesk recorded it (also in `zendesk`), kept here only so the check for the
     * same mail arriving through both intake and the import (phase 6) can use an index. Never used for threading or
     * copies: intake's threading and copy queries read `message_id_header` only. A hash index: the check only compares
     * for equality.
     */
    zendeskMessageId: text("zendesk_message_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("message_source_graph").on(t.sourceId, t.graphId),
    index("message_zendesk_message_id_idx").using("hash", t.zendeskMessageId),
    index("message_state_received_idx").on(t.state, t.receivedAt),
    index("message_message_id_idx").on(t.messageIdHeader),
    index("message_ticket_idx").on(t.ticketId),
    // Search (plan 4.4): the message text, through pg_trgm's documented GIN operator class.
    index("message_text_trgm_idx").using("gin", t.textBody.op("gin_trgm_ops")),
    uniqueIndex("message_submission").on(t.authorUserId, t.submissionId).where(sql`${t.submissionId} is not null`),
    check("message_state", sql`${t.state} in ('stored', 'processed')`),
    check("message_content", sql`${t.content} in ('parsed', 'unavailable', 'unparsed', 'too_large')`),
    check("message_folder", sql`${t.folder} in ('inbox', 'junkemail')`),
    check("message_direction", sql`${t.direction} in ('in', 'out', 'note')`),
    check("message_zendesk", sql`(${t.zendeskKey} is null) = (${t.zendesk} is null)`),
    check(
      "message_imported",
      // An imported comment is written processed on its ticket; an agent's comment or note by the Maane user the admin
      // chose (owner's decision 2), an end user's without one.
      sql`${t.zendeskKey} is null or (${t.ticketId} is not null and ${t.state} = 'processed' and ${t.submissionId} is null and (${t.direction} = 'in') = (${t.authorUserId} is null))`,
    ),
    check(
      "message_incoming",
      // An imported comment (plan 5.1) came from the archive, not from Graph.
      sql`${t.direction} <> 'in' or ${t.zendeskKey} is not null or (${t.sourceId} is not null and ${t.graphId} is not null and ${t.folder} is not null and ${t.graph} is not null)`,
    ),
    check(
      "message_written",
      // A note always has its author; a reply has one too, except an automatic reminder (plan 4.3), sent as the organization.
      // An imported comment has its own rule (message_imported).
      sql`${t.direction} = 'in' or ${t.zendeskKey} is not null or ((${t.authorUserId} is not null or ${t.direction} = 'out') and ${t.submissionId} is not null and ${t.ticketId} is not null and ${t.state} = 'processed')`,
    ),
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
    /**
     * An imported file (plan 5.2): its source key, the Zendesk attachment ID, unique, so a run again updates the same
     * row. Null for every part intake took in. Only a message with a `zendesk_key` has such parts.
     */
    zendeskAttachmentId: text("zendesk_attachment_id").unique(),
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

/** What processing did with a message: one row per processed message. */
export const intakeRecord = pgTable(
  "intake_record",
  {
    messageId: uuid("message_id")
      .primaryKey()
      .references(() => message.id, { onDelete: "restrict" }),
    /** `@maane/shared` INTAKE_OUTCOMES. */
    outcome: text("outcome").notNull(),
    classification: text("classification"),
    /** The concrete support address and its organization (or the default's). */
    supportAddress: text("support_address"),
    organizationId: uuid("organization_id").references(() => organization.id, { onDelete: "restrict" }),
    /** The ticket the message opened or joined. */
    ticketId: uuid("ticket_id").references(() => ticket.id, { onDelete: "restrict" }),
    /** The ticket it matched. */
    matchedTicketId: uuid("matched_ticket_id").references(() => ticket.id, { onDelete: "restrict" }),
    /** A copy: the earlier message it repeats; a delivery report: the reply it is about. */
    matchedMessageId: uuid("matched_message_id").references(() => message.id, { onDelete: "restrict" }),
    /** `@maane/shared` MATCH_LAYERS. */
    matchLayer: text("match_layer"),
    /** A short reason in the code's words (`sender_not_participant`, `auto_submitted`, ...). */
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("intake_record_created_idx").on(t.createdAt),
    check(
      "intake_record_outcome",
      sql`${t.outcome} in ('copy', 'automated', 'unreadable', 'no_address', 'new_ticket', 'joined', 'new_linked_ticket')`,
    ),
  ],
)

// --- Replies that send (phase 3.1) ---

/**
 * An outgoing message: the MIME built once when the agent sent it (so a resend sends the same bytes), its own
 * Message-ID and From address, and where sending is (`@maane/shared` OUTBOX_STATES, which follow its recipients).
 * `problem` says why nothing was sent when a check at send time refused it (`@maane/shared` SEND_PROBLEMS).
 */
export const outbox = pgTable(
  "outbox",
  {
    messageId: uuid("message_id")
      .primaryKey()
      .references(() => message.id, { onDelete: "restrict" }),
    mime: bytea("mime").notNull(),
    /** Without angle brackets, as message.message_id_header. */
    messageIdHeader: text("message_id_header").notNull().unique(),
    /** In lower case: a support address of the ticket's organization when it was written and when it is sent. */
    fromAddress: text("from_address").notNull(),
    state: text("state").notNull().default("pending"),
    problem: text("problem"),
    /**
     * The attempt that owns the row while it is `sending`, a new ID for each claim. Every later step of an attempt
     * (each send, each result) goes on only while this is still its ID and the row still `sending`; a stale attempt
     * stops without sending or writing.
     */
    attempt: uuid("attempt"),
    /**
     * A delivery event about this reply Maane could not tie to one recipient's accepted send (plan 3.3): a failover report
     * that names no accepted recipient or came before the acceptance, or an SMTP2GO event without a known queue ID whose
     * recipient more than one attempt could have reached. Recorded here (when, and from where) without changing a
     * recipient or the ticket's flag.
     */
    unmatchedDeliveryAt: at("unmatched_delivery_at"),
    /** `@maane/shared` DELIVERY_SOURCES. */
    unmatchedDeliverySource: text("unmatched_delivery_source"),
    /**
     * What that event said, for a person to read (`@maane/shared` UnmatchedDelivery without its source and time of
     * recording): `{ status, at, recipient, messageId }`, validated tokens and times only.
     */
    unmatchedDeliveryEvent: jsonb("unmatched_delivery_event"),
    /**
     * The timed action that made this row at its time (plan 4.2), and its version then: at most one row per action
     * and version, so a rerun after a crash finds this row and makes no second message.
     */
    actionId: uuid("action_id").references(() => timedAction.id, { onDelete: "restrict" }),
    actionVersion: integer("action_version"),
    createdAt: createdAt(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("outbox_state_idx").on(t.state),
    check("outbox_state", sql`${t.state} in ('pending', 'sending', 'accepted', 'failed', 'unknown')`),
    uniqueIndex("outbox_action_version_unique").on(t.actionId, t.actionVersion),
    check("outbox_action", sql`(${t.actionId} is null) = (${t.actionVersion} is null)`),
  ],
)

/**
 * One recipient (To or Cc) of an outgoing message and what a provider said about it (`@maane/shared`
 * RECIPIENT_STATES). An `unknown` recipient is never sent to again by itself: the agent sends again or marks it sent.
 */
export const outboxRecipient = pgTable(
  "outbox_recipient",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => outbox.messageId, { onDelete: "restrict" }),
    /** In lower case. */
    address: text("address").notNull(),
    name: text("name"),
    /** `to` or `cc`. */
    kind: text("kind").notNull(),
    position: integer("position").notNull(),
    state: text("state").notNull().default("pending"),
    /** `smtp2go` or `failover`: the provider of the last answer about this recipient. */
    provider: text("provider"),
    /** The provider's reply, bounded: the final reply (with the provider's queue ID) once accepted, else the refusal. */
    response: text("response"),
    /** The agent who marked an unknown recipient as sent. */
    markedBy: text("marked_by").references(() => authUser.id, { onDelete: "restrict" }),
    /** SMTP2GO's queue ID from its final 250, the `email_id` its webhook and activity search name (plan 3.3). */
    providerId: text("provider_id"),
    /** When a provider accepted the reply for this recipient, or an agent marked it as sent (plan 3.3). */
    acceptedAt: at("accepted_at"),
    /**
     * Attempts that may have reached this recipient: each one a provider accepted, or whose outcome is unknown. An
     * SMTP2GO event without a known queue ID is matched by Maane's Message-ID only while this is exactly one.
     */
    possibleSends: integer("possible_sends").notNull().default(0),
    /**
     * What the recipient's server did, by the newest event (`@maane/shared` DELIVERY_STATUSES): written only by delivery
     * events, never by a send's result, and only by an event newer than the one it holds.
     */
    delivery: text("delivery"),
    /** The time of the event that wrote `delivery`, as the provider or the report gave it. */
    deliveryAt: at("delivery_at"),
    /** When Maane wrote that status, by its own clock: the flag counts only a status written after the acceptance. */
    deliveryRecordedAt: at("delivery_recorded_at"),
    /**
     * The time of the first `delivered` event about this recipient (plan 3.4): set once, while it is empty, and never
     * overwritten by a later status (a spam report, a bounce), so a click's "early" mark keeps its reference.
     */
    firstDeliveredAt: at("first_delivered_at"),
    /** The provider's reason or the report's status code, bounded. */
    deliveryDetail: text("delivery_detail"),
    /** `@maane/shared` DELIVERY_SOURCES. */
    deliverySource: text("delivery_source"),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.address] }),
    index("outbox_recipient_provider_id_idx").on(t.providerId),
    check(
      "outbox_recipient_delivery",
      sql`${t.delivery} is null or ${t.delivery} in ('delivered', 'soft_bounce', 'hard_bounce', 'rejected', 'spam')`,
    ),
    check("outbox_recipient_delivery_at", sql`(${t.delivery} is null) = (${t.deliveryAt} is null)`),
    check(
      "outbox_recipient_delivery_source",
      sql`${t.deliverySource} is null or ${t.deliverySource} in ('webhook', 'activity', 'report')`,
    ),
    check("outbox_recipient_kind", sql`${t.kind} in ('to', 'cc')`),
    check("outbox_recipient_state", sql`${t.state} in ('pending', 'accepted', 'refused', 'unknown')`),
    check("outbox_recipient_provider", sql`${t.provider} is null or ${t.provider} in ('smtp2go', 'failover')`),
  ],
)

/**
 * Where SMTP2GO's activity search went on (plan 3.3), one row: the end of the last window every page of which was read.
 * The next run starts a little before it, so an event the provider listed late is still read.
 */
export const deliveryPoll = pgTable(
  "delivery_poll",
  {
    id: integer("id").primaryKey(),
    until: at("until").notNull(),
    /**
     * A window the last run did not finish (it reached its page limit): SMTP2GO's documented `continue_token` and the
     * window it pages through. The next run goes on from there before it starts a new window.
     */
    continueToken: text("continue_token"),
    windowStart: at("window_start"),
    windowEnd: at("window_end"),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [check("delivery_poll_one_row", sql`${t.id} = 1`)],
)

/**
 * A file an agent uploaded in the composer. The server keeps its bytes here only until the worker scanned it (the
 * server never calls the scanner or writes the file store); the worker then stores what may be kept through the file
 * service and clears `content`. Only its uploader may attach it.
 */
export const upload = pgTable(
  "upload",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "restrict" }),
    fileName: text("file_name").notNull(),
    declaredType: text("declared_type"),
    size: bigint("size", { mode: "number" }).notNull(),
    /** The bytes, until the scan decided. */
    content: bytea("content"),
    /** `@maane/shared` UPLOAD_STATUSES. */
    status: text("status").notNull().default("scanning"),
    signature: text("signature"),
    blockedBy: text("blocked_by"),
    storedSha256: text("stored_sha256").references(() => storedFile.sha256, { onDelete: "restrict" }),
    createdAt: createdAt(),
    scannedAt: at("scanned_at"),
  },
  (t) => [
    index("upload_user_idx").on(t.userId),
    check(
      "upload_status",
      sql`${t.status} in ('scanning', 'clean', 'not_fully_scanned', 'not_scanned', 'infected', 'blocked_type', 'too_large', 'scanner_unavailable')`,
    ),
    check("upload_content", sql`(${t.content} is null) = (${t.status} <> 'scanning')`),
    check(
      "upload_stored",
      sql`(${t.storedSha256} is not null) = (${t.status} in ('clean', 'not_fully_scanned', 'not_scanned'))`,
    ),
  ],
)

// --- Link tracking and download links (plan 3.4) ---

/**
 * A link of an outgoing reply (`out`): a link the agent wrote (`url`, the original address) or a file of an earlier
 * message the email's history names (`file`, the part). The code is random (a CSPRNG) and is the only thing the email
 * carries: the target is only what is stored here, so the routes can never redirect elsewhere. A link goes with its
 * reply, and a file link with its part (on delete cascade), so deleting a file or a ticket disables its links; a file
 * link is served only while its part is still a stored file of an incoming message or a reply.
 */
export const trackedLink = pgTable(
  "tracked_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    /** `url` or `file`. */
    kind: text("kind").notNull(),
    url: text("url"),
    partId: uuid("part_id").references(() => messagePart.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("tracked_link_message_idx").on(t.messageId),
    index("tracked_link_part_idx").on(t.partId),
    check("tracked_link_kind", sql`${t.kind} in ('url', 'file')`),
    check(
      "tracked_link_target",
      sql`(${t.kind} = 'url' and ${t.url} is not null and ${t.partId} is null) or (${t.kind} = 'file' and ${t.partId} is not null and ${t.url} is null)`,
    ),
  ],
)

/**
 * One click on a tracked link or one download of a file link: when, from which address (the client address behind the
 * trusted proxies only), where that address is by the local GeoLite2 files, and what the user agent says. Every string
 * is bounded (`@maane/shared` CLICK_BOUNDS).
 */
export const linkClick = pgTable(
  "link_click",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    linkId: uuid("link_id")
      .notNull()
      .references(() => trackedLink.id, { onDelete: "cascade" }),
    at: at("at").notNull().defaultNow(),
    ip: text("ip"),
    country: text("country"),
    city: text("city"),
    region: text("region"),
    isp: text("isp"),
    asn: bigint("asn", { mode: "number" }),
    device: text("device"),
    os: text("os"),
    browser: text("browser"),
    userAgent: text("user_agent"),
  },
  (t) => [index("link_click_link_idx").on(t.linkId, t.at)],
)

// --- Browser notifications (plan 4.5) ---

/**
 * One browser's Web Push subscription (a user on a device): the push service's endpoint and the browser's two keys,
 * which only the worker reads to send. The server sets the owner from the session, never from the request; a row is
 * read, changed, and deleted only by its owner, and deleted with the user. The locale is the UI's language when the
 * user turned notifications on, the language of the notification's words. The endpoint and the keys are never logged
 * and never returned by the API.
 */
export const pushSubscription = pgTable(
  "push_subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    locale: text("locale").notNull(),
    createdAt: createdAt(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("push_subscription_endpoint_idx").on(t.endpoint),
    index("push_subscription_user_idx").on(t.userId),
    check("push_subscription_locale_check", sql`${t.locale} in ('he', 'en')`),
  ],
)

// --- Timed actions (plan 4.2) ---

/**
 * A timed action: something Maane does on a ticket at a chosen time, by one rule (plan 4.2, requirements 2.3). One row
 * per action with a version that every change moves on; its job names the version it was queued for, so the job of a
 * replaced or cancelled version finds a newer one, or a state other than `scheduled`, and does nothing. At its time the
 * job checks the action is still valid and makes at most one outbox row for the version (the unique index on outbox),
 * and the send point checks it once more in the transaction that hands that row to `sending`. Kind-specific content
 * lives in its own table (`scheduled_reply` for a reply). Every path that locks an action locks its ticket first.
 */
export const timedAction = pgTable(
  "timed_action",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `reply`: a scheduled reply (`scheduled_reply`); `reminder`: a waiting period's reminder (`reminder`). */
    kind: text("kind").notNull(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "restrict" }),
    /** The agent who made it; none for a reminder, which Maane sends as the organization. */
    authorUserId: text("author_user_id").references(() => authUser.id, { onDelete: "restrict" }),
    /** The composer's submission ID: one action per click, as for a reply sent at once. */
    submissionId: uuid("submission_id"),
    version: integer("version").notNull().default(1),
    /** `@maane/shared` ACTION_STATES. */
    state: text("state").notNull().default("scheduled"),
    /** `@maane/shared` ACTION_REASONS, for a cancelled or ended action. */
    reason: text("reason"),
    dueAt: at("due_at").notNull(),
    /** By the database's clock: "the customer wrote since the action was made" compares intake's records with it. */
    createdAt: createdAt(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("timed_action_ticket_idx").on(t.ticketId),
    uniqueIndex("timed_action_submission_unique").on(t.authorUserId, t.submissionId),
    check("timed_action_kind", sql`${t.kind} in ('reply', 'reminder')`),
    check("timed_action_state", sql`${t.state} in ('scheduled', 'handed', 'done', 'cancelled', 'ended')`),
  ],
)

/**
 * A scheduled reply's current version, built by the server when it was written or changed (the worker never builds
 * mail: the history's images need sharp): the MIME (dated at its time), the body as the ticket view keeps it, its
 * recipients, files, and links. At its time the worker writes the reply from these, as the server writes one sent at
 * once. `editor_html` and `files` keep what the agent chose, so the composer can change it.
 */
export const scheduledReply = pgTable("scheduled_reply", {
  actionId: uuid("action_id")
    .primaryKey()
    .references(() => timedAction.id, { onDelete: "restrict" }),
  setPending: boolean("set_pending").notNull(),
  editorHtml: text("editor_html").notNull(),
  fromAddress: text("from_address").notNull(),
  /** `MailAddress[]`, parsed and in lower case. */
  toAddresses: jsonb("to_addresses").notNull(),
  ccAddresses: jsonb("cc_addresses").notNull(),
  htmlBody: text("html_body").notNull(),
  textBody: text("text_body").notNull(),
  /** `{ source, id, fileName, contentType, size, sha256, status }[]`: the agent's uploads and the ticket's own files. */
  files: jsonb("files").notNull(),
  mime: bytea("mime").notNull(),
  messageIdHeader: text("message_id_header").notNull(),
  subject: text("subject").notNull(),
  inReplyTo: text("in_reply_to"),
  references: text("references").array().notNull(),
  /** The links its HTML carries (`NewLink[]` of plan 3.4), written with the reply. */
  links: jsonb("links").notNull(),
})

/**
 * A ticket's waiting period (plan 4.3): it starts when an agent's reply that sets the ticket to pending goes to
 * sending (the moment its status action applies), and ends on a customer reply, a status change away from pending, a
 * new agent reply, a move to another organization, or a bounce, rejection, or spam report on the reply that started it
 * (`@maane/shared` PERIOD_END_REASONS). At most one period of a ticket is open. Only a period Maane started (`origin`)
 * sends a reminder; the Zendesk import (phase 5) writes its periods as `import`.
 */
export const waitingPeriod = pgTable(
  "waiting_period",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "restrict" }),
    /** `maane` (Maane started it) or `import` (the Zendesk import, phase 5): only `maane` periods send a reminder. */
    origin: text("origin").notNull(),
    /** The reply that started it (none for an imported period): its bounce ends the period. */
    messageId: uuid("message_id").references(() => message.id, { onDelete: "restrict" }),
    startedAt: at("started_at").notNull().defaultNow(),
    endedAt: at("ended_at"),
    /** `@maane/shared` PERIOD_END_REASONS. */
    endReason: text("end_reason"),
  },
  (t) => [
    uniqueIndex("waiting_period_open_unique").on(t.ticketId).where(sql`${t.endedAt} is null`),
    index("waiting_period_message_idx").on(t.messageId),
    check("waiting_period_origin", sql`${t.origin} in ('maane', 'import')`),
    check("waiting_period_end", sql`(${t.endedAt} is null) = (${t.endReason} is null)`),
    check(
      "waiting_period_end_reason",
      sql`${t.endReason} is null or ${t.endReason} in ('customer_reply', 'status_change', 'agent_reply', 'move', 'delivery_failed')`,
    ),
  ],
)

/**
 * A reminder's content (plan 4.3): the waiting period it belongs to, one reminder per period. Its email is built by the
 * worker at its time (the template, the ticket's From address and customers then), as the organization.
 */
export const reminder = pgTable("reminder", {
  actionId: uuid("action_id")
    .primaryKey()
    .references(() => timedAction.id, { onDelete: "restrict" }),
  periodId: uuid("period_id")
    .notNull()
    .unique()
    .references(() => waitingPeriod.id, { onDelete: "restrict" }),
})

// --- The import from the Zendesk archive (plan 5.1) ---

/**
 * The import's one row (made by a migration, so it always exists and a transaction can lock it): when an admin pressed
 * Finish import, which closes the import window for good (phase 6); the archive origin of the first run, which every
 * later run must match; and the Maane user that Zendesk agents' comments and notes are attributed to (owner's decision
 * 2, 2026-11-16).
 */
export const zendeskImport = pgTable(
  "zendesk_import",
  {
    id: integer("id").primaryKey(),
    /** When an admin pressed Finish import (phase 6): the import window is closed for good from then on. */
    finishedAt: at("finished_at"),
    origin: text("origin"),
    agentUserId: text("agent_user_id").references(() => authUser.id, { onDelete: "restrict" }),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [check("zendesk_import_one_row", sql`${t.id} = 1`)],
)

/** Which organization a Zendesk brand's tickets go to (requirements 3.1): explicit; an unmapped brand is not imported. */
export const zendeskBrandMap = pgTable("zendesk_brand_map", {
  brandId: text("brand_id").primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
})

/** Which category a Zendesk tag gives a ticket (requirements 3.1); a tag without a row gives none. Tags stay as they are. */
export const zendeskTagMap = pgTable("zendesk_tag_map", {
  tag: text("tag").primaryKey(),
  categoryId: uuid("category_id")
    .notNull()
    .references(() => category.id, { onDelete: "cascade" }),
})

/**
 * One run of the import (`@maane/shared` IMPORT_RUN_STATES). At most one is `running`: started and not finished, its
 * job active or waiting to go on. It records the archive state it imports (`state.json`'s run count and coverage)
 * and goes on after a crash from `position` (the last Zendesk ticket ID it committed) only while the archive still
 * holds that state; otherwise it stops, and the next start is a full pass.
 */
export const importRun = pgTable(
  "import_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    state: text("state").notNull().default("running"),
    /** `@maane/shared` IMPORT_STOP_REASONS: why a run was refused or stopped. */
    reason: text("reason"),
    /**
     * Where and why an open run stopped on an error that no ticket caused: `stage:kind`, then `:` and the database
     * constraint's name when one was named (`@maane/shared` IMPORT_STAGES and IMPORT_FAILURES); never the error's text.
     */
    failure: text("failure"),
    /** The first problems of a failed archive check, for the admin to read. */
    problems: jsonb("problems"),
    startedBy: text("started_by").references(() => authUser.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    finishedAt: at("finished_at"),
    archiveOrigin: text("archive_origin"),
    /** `state.json`'s run count and `coveredUntil` of the archive this run imports, read before its check. */
    archiveRuns: integer("archive_runs"),
    coveredUntil: at("covered_until"),
    /** The highest Zendesk ticket ID of the archive. */
    highestNumber: bigint("highest_number", { mode: "number" }),
    /** The last Zendesk ticket ID whose transaction committed; the run goes on after it. */
    position: bigint("position", { mode: "number" }),
    total: integer("total").notNull().default(0),
    done: integer("done").notNull().default(0),
    /** `@maane/shared` ImportCounts. */
    counts: jsonb("counts").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    uniqueIndex("import_run_one_running").on(sql`(true)`).where(sql`${t.state} = 'running'`),
    index("import_run_created_idx").on(t.createdAt),
    check("import_run_state", sql`${t.state} in ('running', 'done', 'stopped', 'refused')`),
  ],
)

/** What a run did not import, or imported only in part, with the reason (`@maane/shared` IMPORT_REPORT_REASONS). */
export const importReport = pgTable(
  "import_report",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => importRun.id, { onDelete: "cascade" }),
    zendeskId: bigint("zendesk_id", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    /** What the reason names: the brand, a comment, a file. */
    detail: text("detail"),
  },
  (t) => [index("import_report_run_idx").on(t.runId, t.id)],
)
