import { isValidUsername, PASSWORD_MAX, PASSWORD_MIN, ROLES, userEmail } from "@maane/shared"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx } from "better-auth/api"
import { admin, twoFactor, username } from "better-auth/plugins"
import { createAccessControl } from "better-auth/plugins/access"
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access"
import { eq } from "drizzle-orm"
import { type Actor, writeAudit } from "../audit.ts"
import type { VersionedKey } from "../config.ts"
import type { Db } from "../db/client.ts"
import { authAccount, authRateLimit, authSession, authTwoFactor, authUser, authVerification } from "../db/schema.ts"
import { errorFacts, log } from "../log.ts"
import type { SetupWindow } from "./setup-window.ts"

// Better Auth as it documents itself: its routes, its plugins (username, twoFactor, admin), its options, and its
// documented hooks. Maane does not wrap its handler. The hooks below only refuse (a closed route, a session without
// two-factor, setup outside its window, a role change that would leave no admin) and write audit rows; Better Auth
// makes every decision about passwords, sessions, and codes. "Foundation 1b design" in docs/project-foundation.md
// lists what this leaves open.

/** How long a two-factor challenge (after the password, before the code) lives: 3 minutes. */
export const TWO_FACTOR_CHALLENGE_S = 180

const DAY_S = 86_400
const HOUR_S = 3_600

/** Routes a browser may call without a full session. The two verify routes also answer the sign-in challenge. */
export const PUBLIC_PATHS = [
  "/ok",
  "/get-session",
  "/sign-up/email",
  "/sign-in/username",
  "/sign-out",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
] as const

/** Routes for a signed-in user whose two-factor is still off: setting it up. */
export const ENROLLMENT_PATHS = ["/two-factor/enable"] as const

/** Routes for a signed-in user whose two-factor is on. */
export const PROTECTED_PATHS = [
  "/change-password",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/admin/create-user",
  "/admin/list-users",
  "/admin/set-role",
  "/admin/ban-user",
  "/admin/unban-user",
  "/admin/revoke-user-sessions",
  "/admin/set-user-password",
] as const

/** Every route a browser may reach. Anything else answers 404 over HTTP, including routes a later version adds. */
export const ALLOWED_PATHS = [...PUBLIC_PATHS, ...ENROLLMENT_PATHS, ...PROTECTED_PATHS] as const

/** Every route whose body accepts `trustDevice` (a cookie that skips the code). Maane asks at every sign-in. */
const TRUST_DEVICE_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"])

/** Credential routes: 5 attempts per 5 minutes per address and route. */
const CREDENTIAL_PATHS = [
  "/sign-up/email",
  "/sign-in/username",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/change-password",
  "/admin/set-user-password",
]

/** Admin actions whose audit row is written before the action (a failed row refuses it). */
const ADMIN_AUDIT: Record<string, string> = {
  "/admin/set-role": "user.set_role",
  "/admin/ban-user": "user.ban",
  "/admin/unban-user": "user.unban",
  "/admin/revoke-user-sessions": "user.revoke_sessions",
  "/admin/set-user-password": "user.set_password",
}

/** Admin actions after which every session of the target user ends. */
const END_SESSIONS_AFTER = new Set(["/admin/set-role", "/admin/set-user-password"])

// The two roles, as the admin plugin documents custom access control: an admin has the plugin admin permissions,
// an agent none of them.
const ac = createAccessControl({ ...defaultStatements } as const)
const roles = { admin: ac.newRole({ ...adminAc.statements }), agent: ac.newRole({ user: [], session: [] }) }

const groupOf = new Map<string, "public" | "enrollment" | "protected">([
  ...PUBLIC_PATHS.map((p) => [p, "public"] as const),
  ...ENROLLMENT_PATHS.map((p) => [p, "enrollment"] as const),
  ...PROTECTED_PATHS.map((p) => [p, "protected"] as const),
])

export interface AuthOptions {
  db: Db
  /** MAANE_AUTH_SECRETS: Better Auth's versioned `secrets`. */
  secrets: VersionedKey[]
  publicUrl: URL
  /** MAANE_TRUSTED_PROXIES: the proxies whose X-Forwarded-For hop Better Auth trusts. */
  trustedProxies: string[]
  setup: SetupWindow
  /** Settings: sign out after this many days. */
  sessionDays: number
}

const refuse = (status: "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST" | "UNAUTHORIZED", code: string, message: string) =>
  new APIError(status, { code, message })

/** Whether any user exists, read on Maane's own connection. */
async function anyUser(db: Db): Promise<boolean> {
  const [row] = await db.select({ id: authUser.id }).from(authUser).limit(1)
  return row !== undefined
}

type HookContext = {
  path?: string
  request?: Request
  context?: { session?: { user?: { id?: string; username?: string | null; name?: string } } | null }
} | null

/** The signed-in user behind a database hook's request, if any. */
function actorOf(context: HookContext): Actor | null {
  const user = context?.context?.session?.user
  if (!user?.id) return null
  return { userId: user.id, label: String(user.username ?? user.name ?? user.id) }
}

/** The client address Better Auth computed, for the audit row. */
function ipOf(request: Request | undefined): string | null {
  return request?.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || null
}

export function createAuth(options: AuthOptions) {
  const { db, publicUrl, setup } = options

  const beforeRoute = createAuthMiddleware(async (c) => {
    // Server calls (auth.api.*) are not HTTP requests: the closed list limits browsers only.
    if (!c.request) return
    const path = c.path
    const group = groupOf.get(path)
    if (!group) throw refuse("NOT_FOUND", "NOT_FOUND", "Nothing is here.")
    const body = (c.body ?? {}) as Record<string, unknown>

    if (TRUST_DEVICE_PATHS.has(path) && body.trustDevice) {
      throw refuse("BAD_REQUEST", "TRUST_DEVICE_UNSUPPORTED", "Maane asks for the code at every sign-in.")
    }
    if (path === "/sign-up/email") {
      if (!setup.isOpen() || (await anyUser(db))) throw refuse("FORBIDDEN", "SETUP_CLOSED", "Setup is closed.")
      // The username plugin treats a missing username as optional; Maane signs in by username only, so the first
      // admin must have one, or nobody could sign in again once the setup session ends.
      if (typeof body.username !== "string" || !isValidUsername(body.username)) {
        throw refuse("BAD_REQUEST", "INVALID_USERNAME", "Choose a valid username.")
      }
      if (body.email !== userEmail(body.username)) {
        throw refuse("BAD_REQUEST", "INVALID_EMAIL", "The e-mail must be the one Maane derives from the username.")
      }
      return
    }
    if (group === "public") return

    const session = await getAuthoritativeSessionFromCtx(c).catch(() => null)
    if (!session?.user) throw refuse("UNAUTHORIZED", "UNAUTHORIZED", "Sign in first.")
    const enabled = session.user.twoFactorEnabled === true
    if (group === "enrollment") {
      if (enabled) throw refuse("FORBIDDEN", "TOTP_ALREADY_ON", "Two-factor authentication is already on.")
      return
    }
    if (!enabled) throw refuse("FORBIDDEN", "TOTP_REQUIRED", "Set up two-factor authentication first.")
    // Better Auth's session read does not refuse a banned user: a ban whose session cleanup failed would otherwise
    // leave the user signed in.
    if ((session.user as { banned?: boolean | null }).banned)
      throw refuse("FORBIDDEN", "BANNED", "This account is disabled.")

    const actor: Actor = {
      userId: session.user.id,
      label: String((session.user as { username?: string }).username ?? session.user.name),
    }
    if (path === "/admin/create-user" || path === "/admin/set-role") {
      if (typeof body.role !== "string" || !(ROLES as readonly string[]).includes(body.role)) {
        throw refuse("BAD_REQUEST", "INVALID_ROLE", "The role must be admin or agent.")
      }
    }
    if (path === "/admin/create-user") {
      const data = (body.data ?? {}) as Record<string, unknown>
      const name = data.username
      if (typeof name !== "string" || !isValidUsername(name) || body.email !== userEmail(name)) {
        throw refuse("BAD_REQUEST", "INVALID_USERNAME", "Choose a valid username.")
      }
      // create-user passes `data` straight to the new row: only the username may come through it.
      if (Object.keys(data).some((key) => key !== "username")) {
        throw refuse("BAD_REQUEST", "INVALID_FIELDS", "Only a username may be set this way.")
      }
      return // audited when the user row is created
    }
    const target = typeof body.userId === "string" ? body.userId : null
    // The acting admin never changes their own role, and the plugin refuses banning oneself, so the actor always
    // stays an admin. Two admins demoting each other at the same moment can still leave none (an owner gap).
    if (path === "/admin/set-role" && target === actor.userId) {
      throw refuse("FORBIDDEN", "OWN_ROLE", "An admin cannot change their own role.")
    }
    const action = ADMIN_AUDIT[path]
    if (action) {
      await writeAudit(db, actor, {
        action,
        entityType: "user",
        entityId: target,
        details: path === "/admin/set-role" ? { role: body.role } : undefined,
        ipAddress: ipOf(c.request),
      })
    }
  })

  /**
   * After a role change or an admin's password reset, every session of that user ends, through the plugin's
   * documented action. The change is already stored here: a failure leaves the old sessions alive (with the new
   * role in force on their next request), an owner gap recorded in the foundation plan. Sign-out is recorded here
   * too, because Better Auth swallows a throwing sign-out hook and leaves the session valid. This hook never throws.
   */
  const afterRoute = createAuthMiddleware(async (c) => {
    if (!c.request) return
    const returned = (c.context as { returned?: unknown }).returned
    if (returned instanceof APIError || returned instanceof Error) return
    try {
      if (END_SESSIONS_AFTER.has(c.path)) {
        const target = (c.body as { userId?: unknown } | undefined)?.userId
        if (typeof target === "string") {
          await auth.api.revokeUserSessions({ body: { userId: target }, headers: c.request.headers })
        }
      } else if (c.path === "/sign-out") {
        const session = (c.context as HookContext)?.context?.session
        const actor = actorOf({ context: { session } })
        if (actor) await writeAudit(db, actor, { action: "session.sign_out", entityType: "session" })
      }
    } catch (error) {
      log.error("an after-route step failed", { path: c.path, ...errorFacts(error) })
    }
  })

  const auth = betterAuth({
    appName: "Maane",
    secrets: options.secrets.map((k) => ({ version: k.version, value: k.value })),
    basePath: "/api/auth",
    baseURL: publicUrl.origin,
    trustedOrigins: [publicUrl.origin],
    telemetry: { enabled: false },
    logger: { level: "error", log: logBetterAuth },
    onAPIError: { throw: true },
    database: drizzleAdapter(db, {
      provider: "pg",
      transaction: true,
      schema: {
        user: authUser,
        session: authSession,
        account: authAccount,
        verification: authVerification,
        twoFactor: authTwoFactor,
        rateLimit: authRateLimit,
      },
    }),
    user: {
      additionalFields: {
        // The first admin, made by the setup screen. A partial unique index allows one such user, ever.
        setupAdmin: { type: "boolean", required: false, defaultValue: false, input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      revokeSessionsOnPasswordReset: true,
    },
    session: {
      expiresIn: options.sessionDays * DAY_S,
      updateAge: HOUR_S,
      deferSessionRefresh: true,
      freshAge: 0,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: Object.fromEntries(CREDENTIAL_PATHS.map((p) => [p, { window: 300, max: 5 }])),
    },
    advanced: {
      // Better Auth skips its origin check under NODE_ENV=test; Maane keeps it on everywhere.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: publicUrl.protocol === "https:",
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: options.trustedProxies },
    },
    hooks: { before: beforeRoute, after: afterRoute },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            const ctx = context as HookContext
            if (ctx?.path === "/sign-up/email") {
              // Checked again at creation: a request that started just before the window closed is refused here.
              if (!setup.isOpen()) throw refuse("FORBIDDEN", "SETUP_CLOSED", "Setup is closed.")
              const name = String((user as { username?: string }).username ?? user.name)
              await writeAudit(
                db,
                { userId: null, label: "system" },
                {
                  action: "account.setup",
                  entityType: "user",
                  details: { username: name },
                  ipAddress: ipOf(ctx.request),
                },
              )
              return { data: { ...user, role: "admin", setupAdmin: true } }
            }
            const actor = actorOf(ctx)
            if (actor) {
              await writeAudit(db, actor, {
                action: "user.create",
                entityType: "user",
                details: {
                  username: (user as { username?: string }).username ?? null,
                  role: (user as { role?: string }).role ?? null,
                },
                ipAddress: ipOf(ctx?.request),
              })
            }
            return { data: { ...user, setupAdmin: false } }
          },
        },
        update: {
          before: async (data, context) => {
            if (!("twoFactorEnabled" in data) || data.twoFactorEnabled === undefined) return
            const actor = actorOf(context as HookContext)
            if (!actor) return
            await writeAudit(db, actor, {
              action: data.twoFactorEnabled ? "account.totp_enable" : "account.totp_disable",
              entityType: "user",
              entityId: actor.userId,
            })
          },
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            const path = (context as HookContext)?.path ?? ""
            if (
              path !== "/sign-in/username" &&
              path !== "/two-factor/verify-totp" &&
              path !== "/two-factor/verify-backup-code"
            )
              return
            const userId = String((session as { userId?: string }).userId ?? "")
            const [row] = await db.select({ username: authUser.username }).from(authUser).where(eq(authUser.id, userId))
            await writeAudit(
              db,
              { userId, label: row?.username ?? userId },
              {
                action: "session.sign_in",
                entityType: "session",
                details: { stage: path === "/sign-in/username" ? "password" : "second_factor" },
                ipAddress: ipOf((context as HookContext)?.request),
              },
            )
          },
        },
      },
      account: {
        update: {
          before: async (data, context) => {
            if (!(data as { password?: string }).password) return
            const actor = actorOf(context as HookContext)
            if (!actor || (context as HookContext)?.path !== "/change-password") return
            await writeAudit(db, actor, {
              action: "account.password_change",
              entityType: "user",
              entityId: actor.userId,
            })
          },
        },
      },
    },
    plugins: [
      username({ usernameValidator: isValidUsername }),
      twoFactor({ issuer: "Maane", twoFactorCookieMaxAge: TWO_FACTOR_CHALLENGE_S }),
      admin({
        ac,
        roles,
        defaultRole: "agent",
        adminRoles: ["admin"],
      }),
    ],
  })
  return auth
}

export type Auth = ReturnType<typeof createAuth>

/** Better Auth's own log lines: the level and the facts of any error passed along, never the message itself. */
export function logBetterAuth(level: string, _message: string, ...args: unknown[]): void {
  const error = args.find((arg) => arg instanceof Error)
  const facts = error ? errorFacts(error) : {}
  if (level === "error") log.error("better auth reported an error", facts)
  else if (level === "warn") log.warn("better auth reported a warning", facts)
}
