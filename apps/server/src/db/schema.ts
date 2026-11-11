import { sql } from "drizzle-orm"
import { bigint, bigserial, boolean, check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

const at = (name: string) => timestamp(name, { withTimezone: true })
const createdAt = () => at("created_at").notNull().defaultNow()

// --- Better Auth (core, username, twoFactor, admin), in the shape its Drizzle adapter documents ---

export const authUser = pgTable("auth_user", {
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
  createdAt: createdAt(),
  updatedAt: at("updated_at").notNull().defaultNow(),
})

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

/**
 * The first-run setup claim: at most one row ever (the check pins its id). The setup sign-up inserts it before the
 * first user is created, so of two requests that pass the open-setup check together only one gets this far.
 */
export const setupClaim = pgTable(
  "setup_claim",
  {
    id: integer("id").primaryKey().default(1),
    claimedAt: createdAt(),
  },
  (t) => [check("setup_claim_single_row", sql`${t.id} = 1`)],
)

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
