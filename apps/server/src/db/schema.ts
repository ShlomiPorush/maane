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
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" })
const createdAt = () => at("created_at").notNull().defaultNow()

export const authUser = pgTable(
  "auth_user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    username: text("username").unique(),
    displayUsername: text("display_username"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false),
    role: text("role"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: at("ban_expires"),
    setupAdmin: boolean("setup_admin").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
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

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: at("at").notNull().defaultNow(),
    actorUserId: text("actor_user_id").references(() => authUser.id, { onDelete: "set null" }),
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    details: jsonb("details"),
    ipAddress: text("ip_address"),
  },
  (t) => [index("audit_log_at_idx").on(t.at), index("audit_log_actor_idx").on(t.actorUserId)],
)

export const organization = pgTable(
  "organization",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    signature: text("signature").notNull().default(""),
    reminderTemplate: text("reminder_template").notNull().default(""),
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

export const supportAddress = pgTable(
  "support_address",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    value: text("value").notNull().unique(),
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

export const storedFile = pgTable(
  "stored_file",
  {
    sha256: text("sha256").primaryKey(),
    size: bigint("size", { mode: "number" }).notNull(),
    detectedType: text("detected_type").notNull(),
    scanStatus: text("scan_status").notNull(),
    signature: text("signature"),
    scannedAt: at("scanned_at"),
    createdAt: createdAt(),
  },
  (t) => [
    check("stored_file_sha256", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("stored_file_size", sql`${t.size} >= 0`),
    check("stored_file_status", sql`${t.scanStatus} in ('clean', 'not_fully_scanned', 'not_scanned')`),
  ],
)

export const scannerCheck = pgTable(
  "scanner_check",
  {
    id: integer("id").primaryKey(),
    address: text("address").notNull(),
    ok: boolean("ok").notNull(),
    failedCheck: text("failed_check"),
    version: text("version"),
    checkedAt: at("checked_at").notNull(),
  },
  (t) => [check("scanner_check_one_row", sql`${t.id} = 1`)],
)

export const intakeSource = pgTable(
  "intake_source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
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

export const intakeCursor = pgTable(
  "intake_cursor",
  {
    sourceId: uuid("source_id")
      .notNull()
      .references(() => intakeSource.id, { onDelete: "restrict" }),
    folder: text("folder").notNull(),
    link: text("link").notNull(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.folder] }),
    check("intake_cursor_folder", sql`${t.folder} in ('inbox', 'junkemail')`),
  ],
)

export const ticketNumber = pgSequence("ticket_number_seq", { startWith: 1 })

export const ticket = pgTable(
  "ticket",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: bigint("number", { mode: "number" }).notNull().unique().default(sql`nextval('ticket_number_seq')`),
    referenceCode: text("reference_code").notNull().unique(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    supportAddress: text("support_address").notNull(),
    subject: text("subject"),
    status: text("status").notNull().default("new"),
    reviewFlags: text("review_flags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    lastActivityAt: at("last_activity_at").notNull().defaultNow(),
    snoozedUntil: at("snoozed_until"),
    zendeskId: bigint("zendesk_id", { mode: "number" }).unique(),
    zendesk: jsonb("zendesk"),
  },
  (t) => [
    index("ticket_organization_idx").on(t.organizationId),
    check("ticket_zendesk", sql`(${t.zendeskId} is null) = (${t.zendesk} is null)`),
    index("ticket_subject_trgm_idx").using("gin", t.subject.op("gin_trgm_ops")),
    check("ticket_status", sql`${t.status} in ('new', 'open', 'pending', 'on_hold', 'solved', 'closed')`),
    check(
      "ticket_reference_code",
      sql`${t.referenceCode} ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$'`,
    ),
  ],
)

export const ticketParticipant = pgTable(
  "ticket_participant",
  {
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "restrict" }),
    address: text("address").notNull(),
    name: text("name"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.ticketId, t.address] }),
    index("ticket_participant_address_trgm_idx").using("gin", t.address.op("gin_trgm_ops")),
    index("ticket_participant_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
  ],
)

export const ticketLink = pgTable(
  "ticket_link",
  {
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "restrict" }),
    linkedTicketId: uuid("linked_ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.ticketId, t.linkedTicketId] }),
    index("ticket_link_linked_idx").on(t.linkedTicketId),
  ],
)

export const category = pgTable(
  "category",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("category_name_unique").on(sql`lower(${t.name})`),
    check("category_name_form", sql`${t.name} = btrim(${t.name}) and char_length(${t.name}) between 1 and 80`),
  ],
)

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

export const message = pgTable(
  "message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    direction: text("direction").notNull().default("in"),
    sourceId: uuid("source_id").references(() => intakeSource.id, { onDelete: "restrict" }),
    graphId: text("graph_id"),
    folder: text("folder"),
    receivedAt: at("received_at").notNull(),
    state: text("state").notNull().default("stored"),
    content: text("content").notNull(),
    graph: jsonb("graph"),
    size: bigint("size", { mode: "number" }),
    messageIdHeader: text("message_id_header"),
    inReplyTo: text("in_reply_to").array().notNull().default(sql`'{}'::text[]`),
    references: text("references").array().notNull().default(sql`'{}'::text[]`),
    fromAddress: text("from_address"),
    fromName: text("from_name"),
    toAddresses: jsonb("to_addresses").notNull().default(sql`'[]'::jsonb`),
    ccAddresses: jsonb("cc_addresses").notNull().default(sql`'[]'::jsonb`),
    sentAt: at("sent_at"),
    subject: text("subject"),
    textBody: text("text_body"),
    htmlBody: text("html_body"),
    contentHash: text("content_hash"),
    rawStatus: text("raw_status"),
    rawSha256: text("raw_sha256").references(() => storedFile.sha256, { onDelete: "restrict" }),
    reportOriginalMessageId: text("report_original_message_id"),
    deliveryReport: jsonb("delivery_report").$type<{ address: string; action: string; status: string | null }[]>(),
    fieldScans: jsonb("field_scans").notNull().default(sql`'{}'::jsonb`),
    possiblyAutomated: boolean("possibly_automated").notNull().default(false),
    processAttempts: integer("process_attempts").notNull().default(0),
    retryAt: at("retry_at"),
    reviewFlags: text("review_flags").array().notNull().default(sql`'{}'::text[]`),
    classification: text("classification"),
    automatedReasons: text("automated_reasons").array().notNull().default(sql`'{}'::text[]`),
    ticketId: uuid("ticket_id").references(() => ticket.id, { onDelete: "restrict" }),
    duplicateOf: uuid("duplicate_of"),
    processedAt: at("processed_at"),
    authorUserId: text("author_user_id").references(() => authUser.id, { onDelete: "restrict" }),
    submissionId: uuid("submission_id"),
    zendeskKey: text("zendesk_key").unique(),
    zendesk: jsonb("zendesk"),
    zendeskMessageId: text("zendesk_message_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("message_source_graph").on(t.sourceId, t.graphId),
    index("message_zendesk_message_id_idx").using("hash", t.zendeskMessageId),
    index("message_state_received_idx").on(t.state, t.receivedAt),
    index("message_message_id_idx").on(t.messageIdHeader),
    index("message_ticket_idx").on(t.ticketId),
    index("message_text_trgm_idx").using("gin", t.textBody.op("gin_trgm_ops")),
    uniqueIndex("message_submission").on(t.authorUserId, t.submissionId).where(sql`${t.submissionId} is not null`),
    check("message_state", sql`${t.state} in ('stored', 'processed')`),
    check("message_content", sql`${t.content} in ('parsed', 'unavailable', 'unparsed', 'too_large')`),
    check("message_folder", sql`${t.folder} in ('inbox', 'junkemail')`),
    check("message_direction", sql`${t.direction} in ('in', 'out', 'note')`),
    check("message_zendesk", sql`(${t.zendeskKey} is null) = (${t.zendesk} is null)`),
    check(
      "message_imported",
      sql`${t.zendeskKey} is null or (${t.ticketId} is not null and ${t.state} = 'processed' and ${t.submissionId} is null and (${t.direction} = 'in') = (${t.authorUserId} is null))`,
    ),
    check(
      "message_incoming",
      sql`${t.direction} <> 'in' or ${t.zendeskKey} is not null or (${t.sourceId} is not null and ${t.graphId} is not null and ${t.folder} is not null and ${t.graph} is not null)`,
    ),
    check(
      "message_written",
      sql`${t.direction} = 'in' or ${t.zendeskKey} is not null or ((${t.authorUserId} is not null or ${t.direction} = 'out') and ${t.submissionId} is not null and ${t.ticketId} is not null and ${t.state} = 'processed')`,
    ),
  ],
)

export const messagePart = pgTable(
  "message_part",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "restrict" }),
    index: integer("index").notNull(),
    kind: text("kind").notNull(),
    fileName: text("file_name"),
    declaredType: text("declared_type"),
    contentId: text("content_id"),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    status: text("status").notNull(),
    signature: text("signature"),
    blockedBy: text("blocked_by"),
    storedSha256: text("stored_sha256").references(() => storedFile.sha256, { onDelete: "restrict" }),
    unavailableReason: text("unavailable_reason"),
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

export const intakeRecord = pgTable(
  "intake_record",
  {
    messageId: uuid("message_id")
      .primaryKey()
      .references(() => message.id, { onDelete: "restrict" }),
    outcome: text("outcome").notNull(),
    classification: text("classification"),
    supportAddress: text("support_address"),
    organizationId: uuid("organization_id").references(() => organization.id, { onDelete: "restrict" }),
    ticketId: uuid("ticket_id").references(() => ticket.id, { onDelete: "restrict" }),
    matchedTicketId: uuid("matched_ticket_id").references(() => ticket.id, { onDelete: "restrict" }),
    matchedMessageId: uuid("matched_message_id").references(() => message.id, { onDelete: "restrict" }),
    matchLayer: text("match_layer"),
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

export const outbox = pgTable(
  "outbox",
  {
    messageId: uuid("message_id")
      .primaryKey()
      .references(() => message.id, { onDelete: "restrict" }),
    mime: bytea("mime").notNull(),
    messageIdHeader: text("message_id_header").notNull().unique(),
    fromAddress: text("from_address").notNull(),
    state: text("state").notNull().default("pending"),
    problem: text("problem"),
    attempt: uuid("attempt"),
    unmatchedDeliveryAt: at("unmatched_delivery_at"),
    unmatchedDeliverySource: text("unmatched_delivery_source"),
    unmatchedDeliveryEvent: jsonb("unmatched_delivery_event"),
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

export const outboxRecipient = pgTable(
  "outbox_recipient",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => outbox.messageId, { onDelete: "restrict" }),
    address: text("address").notNull(),
    name: text("name"),
    kind: text("kind").notNull(),
    position: integer("position").notNull(),
    state: text("state").notNull().default("pending"),
    provider: text("provider"),
    response: text("response"),
    markedBy: text("marked_by").references(() => authUser.id, { onDelete: "restrict" }),
    providerId: text("provider_id"),
    acceptedAt: at("accepted_at"),
    possibleSends: integer("possible_sends").notNull().default(0),
    delivery: text("delivery"),
    deliveryAt: at("delivery_at"),
    deliveryRecordedAt: at("delivery_recorded_at"),
    firstDeliveredAt: at("first_delivered_at"),
    deliveryDetail: text("delivery_detail"),
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

export const deliveryPoll = pgTable(
  "delivery_poll",
  {
    id: integer("id").primaryKey(),
    until: at("until").notNull(),
    continueToken: text("continue_token"),
    windowStart: at("window_start"),
    windowEnd: at("window_end"),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [check("delivery_poll_one_row", sql`${t.id} = 1`)],
)

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
    content: bytea("content"),
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

export const trackedLink = pgTable(
  "tracked_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
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

export const timedAction = pgTable(
  "timed_action",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "restrict" }),
    authorUserId: text("author_user_id").references(() => authUser.id, { onDelete: "restrict" }),
    submissionId: uuid("submission_id"),
    version: integer("version").notNull().default(1),
    state: text("state").notNull().default("scheduled"),
    reason: text("reason"),
    dueAt: at("due_at").notNull(),
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

export const scheduledReply = pgTable("scheduled_reply", {
  actionId: uuid("action_id")
    .primaryKey()
    .references(() => timedAction.id, { onDelete: "restrict" }),
  setPending: boolean("set_pending").notNull(),
  editorHtml: text("editor_html").notNull(),
  fromAddress: text("from_address").notNull(),
  toAddresses: jsonb("to_addresses").notNull(),
  ccAddresses: jsonb("cc_addresses").notNull(),
  htmlBody: text("html_body").notNull(),
  textBody: text("text_body").notNull(),
  files: jsonb("files").notNull(),
  mime: bytea("mime").notNull(),
  messageIdHeader: text("message_id_header").notNull(),
  subject: text("subject").notNull(),
  inReplyTo: text("in_reply_to"),
  references: text("references").array().notNull(),
  links: jsonb("links").notNull(),
})

export const waitingPeriod = pgTable(
  "waiting_period",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "restrict" }),
    origin: text("origin").notNull(),
    messageId: uuid("message_id").references(() => message.id, { onDelete: "restrict" }),
    startedAt: at("started_at").notNull().defaultNow(),
    endedAt: at("ended_at"),
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

export const reminder = pgTable("reminder", {
  actionId: uuid("action_id")
    .primaryKey()
    .references(() => timedAction.id, { onDelete: "restrict" }),
  periodId: uuid("period_id")
    .notNull()
    .unique()
    .references(() => waitingPeriod.id, { onDelete: "restrict" }),
})

export const zendeskImport = pgTable(
  "zendesk_import",
  {
    id: integer("id").primaryKey(),
    finishedAt: at("finished_at"),
    origin: text("origin"),
    agentUserId: text("agent_user_id").references(() => authUser.id, { onDelete: "restrict" }),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [check("zendesk_import_one_row", sql`${t.id} = 1`)],
)

export const zendeskBrandMap = pgTable("zendesk_brand_map", {
  brandId: text("brand_id").primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
})

export const zendeskTagMap = pgTable("zendesk_tag_map", {
  tag: text("tag").primaryKey(),
  categoryId: uuid("category_id")
    .notNull()
    .references(() => category.id, { onDelete: "cascade" }),
})

export const importRun = pgTable(
  "import_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    state: text("state").notNull().default("running"),
    reason: text("reason"),
    failure: text("failure"),
    problems: jsonb("problems"),
    startedBy: text("started_by").references(() => authUser.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    finishedAt: at("finished_at"),
    archiveOrigin: text("archive_origin"),
    archiveRuns: integer("archive_runs"),
    coveredUntil: at("covered_until"),
    highestNumber: bigint("highest_number", { mode: "number" }),
    position: bigint("position", { mode: "number" }),
    total: integer("total").notNull().default(0),
    done: integer("done").notNull().default(0),
    counts: jsonb("counts").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    uniqueIndex("import_run_one_running").on(sql`(true)`).where(sql`${t.state} = 'running'`),
    index("import_run_created_idx").on(t.createdAt),
    check("import_run_state", sql`${t.state} in ('running', 'done', 'stopped', 'refused')`),
  ],
)

export const importReport = pgTable(
  "import_report",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => importRun.id, { onDelete: "cascade" }),
    zendeskId: bigint("zendesk_id", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    detail: text("detail"),
  },
  (t) => [index("import_report_run_idx").on(t.runId, t.id)],
)
