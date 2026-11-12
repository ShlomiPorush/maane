import { sql } from "drizzle-orm"
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
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
