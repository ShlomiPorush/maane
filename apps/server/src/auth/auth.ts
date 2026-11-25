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
import { CLIENT_ADDRESS_HEADER, clientIp } from "../http/client.ts"
import { errorFacts, log } from "../log.ts"
import { clearMemberships } from "../organizations/service.ts"
import type { SetupWindow } from "./setup-window.ts"

export const TWO_FACTOR_CHALLENGE_S = 180

const DAY_S = 86_400
const HOUR_S = 3_600

export const PUBLIC_PATHS = [
  "/ok",
  "/get-session",
  "/sign-up/email",
  "/sign-in/username",
  "/sign-out",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
] as const

export const ENROLLMENT_PATHS = ["/two-factor/enable"] as const

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

export const ALLOWED_PATHS = [...PUBLIC_PATHS, ...ENROLLMENT_PATHS, ...PROTECTED_PATHS] as const

const TRUST_DEVICE_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"])

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

const ADMIN_AUDIT: Record<string, string> = {
  "/admin/set-role": "user.set_role",
  "/admin/ban-user": "user.ban",
  "/admin/unban-user": "user.unban",
  "/admin/revoke-user-sessions": "user.revoke_sessions",
  "/admin/set-user-password": "user.set_password",
}

const ACCOUNT_AUDIT: Record<string, string> = {
  "/revoke-session": "session.revoke",
  "/revoke-sessions": "session.revoke_all",
  "/revoke-other-sessions": "session.revoke_others",
  "/two-factor/generate-backup-codes": "account.backup_codes_new",
}

const TARGET_PATHS = new Set(Object.keys(ADMIN_AUDIT))

const END_SESSIONS_AFTER = new Set(["/admin/set-role", "/admin/set-user-password"])

const ac = createAccessControl({ ...defaultStatements } as const)
const roles = { admin: ac.newRole({ ...adminAc.statements }), agent: ac.newRole({ user: [], session: [] }) }

const groupOf = new Map<string, "public" | "enrollment" | "protected">([
  ...PUBLIC_PATHS.map((p) => [p, "public"] as const),
  ...ENROLLMENT_PATHS.map((p) => [p, "enrollment"] as const),
  ...PROTECTED_PATHS.map((p) => [p, "protected"] as const),
])

export interface AuthOptions {
  db: Db
  auditDb: Db
  secrets: VersionedKey[]
  publicUrl: URL
  setup: SetupWindow
  sessionDays: number
}

const refuse = (status: "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST" | "UNAUTHORIZED", code: string, message: string) =>
  new APIError(status, { code, message })

async function anyUser(db: Db): Promise<boolean> {
  const [row] = await db.select({ id: authUser.id }).from(authUser).limit(1)
  return row !== undefined
}

async function isSetupAdmin(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ setupAdmin: authUser.setupAdmin }).from(authUser).where(eq(authUser.id, userId))
  return row?.setupAdmin === true
}

type HookContext = {
  path?: string
  request?: Request
  context?: { session?: { user?: { id?: string; username?: string | null; name?: string } } | null }
} | null

function actorOf(context: HookContext): Actor | null {
  const user = context?.context?.session?.user
  if (!user?.id) return null
  return { userId: user.id, label: String(user.username ?? user.name ?? user.id) }
}

const ipOf = (request: Request | undefined): string | null => clientIp(request)

function validPassword(value: unknown): boolean {
  return typeof value === "string" && value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX
}

export function createAuth(options: AuthOptions) {
  const { db, auditDb, publicUrl, setup } = options
  const signingOut = new WeakMap<Request, Actor>()
  const changingRole = new WeakMap<Request, Actor>()

  const beforeRoute = createAuthMiddleware(async (c) => {
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
      if (typeof body.username !== "string" || !isValidUsername(body.username)) {
        throw refuse("BAD_REQUEST", "INVALID_USERNAME", "Choose a valid username.")
      }
      if (body.email !== userEmail(body.username)) {
        throw refuse("BAD_REQUEST", "INVALID_EMAIL", "The e-mail must be the one Maane derives from the username.")
      }
      return
    }
    if (path === "/sign-out") {
      const leaving = await getAuthoritativeSessionFromCtx(c).catch(() => null)
      if (leaving?.user) {
        signingOut.set(c.request, {
          userId: leaving.user.id,
          label: String((leaving.user as { username?: string }).username ?? leaving.user.name),
        })
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
    const newPassword = path === "/admin/create-user" ? body.password : body.newPassword
    if ((path === "/admin/create-user" || path === "/admin/set-user-password") && !validPassword(newPassword)) {
      throw refuse(
        "BAD_REQUEST",
        "INVALID_PASSWORD",
        `The password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`,
      )
    }
    if (path === "/admin/create-user") {
      const data = (body.data ?? {}) as Record<string, unknown>
      const name = data.username
      if (typeof name !== "string" || !isValidUsername(name) || body.email !== userEmail(name)) {
        throw refuse("BAD_REQUEST", "INVALID_USERNAME", "Choose a valid username.")
      }
      if (Object.keys(data).some((key) => key !== "username")) {
        throw refuse("BAD_REQUEST", "INVALID_FIELDS", "Only a username may be set this way.")
      }
      return
    }
    if (TARGET_PATHS.has(path) && (typeof body.userId !== "string" || body.userId.length === 0)) {
      throw refuse("BAD_REQUEST", "INVALID_USER", "Choose a user.")
    }
    const target = typeof body.userId === "string" ? body.userId : null
    const accountAction = ACCOUNT_AUDIT[path]
    if (accountAction) {
      await writeAudit(auditDb, actor, {
        action: accountAction,
        entityType: "user",
        entityId: actor.userId,
        ipAddress: ipOf(c.request),
      })
      return
    }
    if (path === "/admin/set-role" && target === actor.userId) {
      throw refuse("FORBIDDEN", "OWN_ROLE", "An admin cannot change their own role.")
    }
    if ((path === "/admin/set-role" || path === "/admin/ban-user") && target && (await isSetupAdmin(db, target))) {
      throw refuse("FORBIDDEN", "SETUP_ADMIN_PROTECTED", "The first admin cannot be demoted or disabled.")
    }
    if (path === "/admin/set-role") changingRole.set(c.request, actor)
    const action = ADMIN_AUDIT[path]
    if (action) {
      await writeAudit(auditDb, actor, {
        action,
        entityType: "user",
        entityId: target,
        details: path === "/admin/set-role" ? { role: body.role } : undefined,
        ipAddress: ipOf(c.request),
      })
    }
  })

  const afterRoute = createAuthMiddleware(async (c) => {
    if (!c.request) return
    const returned = (c.context as { returned?: unknown }).returned
    if (returned instanceof APIError || returned instanceof Error) return
    if (c.path === "/admin/set-role") {
      const body = (c.body ?? {}) as { userId?: unknown; role?: unknown }
      const actor = changingRole.get(c.request)
      try {
        if (typeof body.userId === "string" && actor)
          await clearMemberships(db, body.userId, body.role, { actor, ipAddress: ipOf(c.request) })
      } catch (error) {
        log.error("removing the memberships of a user whose role changed failed", errorFacts(error))
      }
    }
    try {
      if (END_SESSIONS_AFTER.has(c.path)) {
        const target = (c.body as { userId?: unknown } | undefined)?.userId
        if (typeof target === "string") {
          await auth.api.revokeUserSessions({ body: { userId: target }, headers: c.request.headers })
        }
      } else if (c.path === "/sign-out") {
        const actor = signingOut.get(c.request)
        if (actor)
          await writeAudit(auditDb, actor, {
            action: "session.sign_out",
            entityType: "session",
            ipAddress: ipOf(c.request),
          })
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
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: publicUrl.protocol === "https:",
      ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
    },
    hooks: { before: beforeRoute, after: afterRoute },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            const ctx = context as HookContext
            if (ctx?.path === "/sign-up/email") {
              if (!setup.isOpen()) throw refuse("FORBIDDEN", "SETUP_CLOSED", "Setup is closed.")
              const name = String((user as { username?: string }).username ?? user.name)
              await writeAudit(
                auditDb,
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
              await writeAudit(auditDb, actor, {
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
            await writeAudit(auditDb, actor, {
              action: data.twoFactorEnabled ? "account.totp_enable" : "account.totp_disable",
              entityType: "user",
              entityId: actor.userId,
              ipAddress: ipOf((context as HookContext)?.request),
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
              auditDb,
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
            await writeAudit(auditDb, actor, {
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

export function logBetterAuth(level: string, _message: string, ...args: unknown[]): void {
  const error = args.find((arg) => arg instanceof Error)
  const facts = error ? errorFacts(error) : {}
  if (level === "error") log.error("better auth reported an error", facts)
  else if (level === "warn") log.warn("better auth reported a warning", facts)
}
