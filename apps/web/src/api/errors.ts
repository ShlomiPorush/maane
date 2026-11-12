// What a failed request means to the person who sent it, in their language. Maane's API answers {error: "code"}
// (lower case); Better Auth and Maane's refusals on Better Auth's routes answer {code, message} (upper case). Both
// map here, through one table, to a locale key: short, truthful, and saying what to do next. The server's own
// English message is never shown. A code the table does not know falls back by its HTTP status.

import { PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN } from "@maane/shared"
import { AuthCallError, type AuthError } from "./auth.ts"
import { ApiError } from "./client.ts"

/** Every server code the UI explains, and the locale key that does. */
export const ERROR_TEXT: Record<string, string> = {
  // Maane's API (/api/v1, /api/setup)
  unauthorized: "errors.code.unauthorized",
  totp_required: "errors.code.totpRequired",
  forbidden: "errors.code.forbidden",
  not_found: "errors.code.notFound",
  csrf_refused: "errors.code.csrfRefused",
  setting_locked: "errors.code.settingLocked",
  setting_invalid: "errors.code.settingInvalid",
  setting_unknown: "errors.code.settingUnknown",
  internal: "errors.server",
  // Maane's refusals on Better Auth's routes (apps/server/src/auth/auth.ts)
  UNAUTHORIZED: "errors.code.unauthorized",
  TOTP_REQUIRED: "errors.code.totpRequired",
  TOTP_ALREADY_ON: "errors.code.totpAlreadyOn",
  BANNED: "errors.code.banned",
  SETUP_CLOSED: "errors.code.setupClosed",
  INVALID_USERNAME: "errors.code.invalidUsername",
  INVALID_EMAIL: "errors.code.invalidUsername",
  INVALID_ROLE: "errors.code.invalidRole",
  INVALID_FIELDS: "errors.code.invalidFields",
  OWN_ROLE: "errors.code.ownRole",
  SETUP_ADMIN_PROTECTED: "errors.code.setupAdminProtected",
  TRUST_DEVICE_UNSUPPORTED: "errors.code.trustDevice",
  NOT_FOUND: "errors.code.notFound",
  // Better Auth's own codes
  INVALID_USERNAME_OR_PASSWORD: "errors.code.wrongCredentials",
  INVALID_PASSWORD: "errors.code.wrongPassword",
  INVALID_CODE: "errors.code.wrongCode",
  INVALID_BACKUP_CODE: "errors.code.wrongBackupCode",
  INVALID_TWO_FACTOR_COOKIE: "errors.code.codeExpired",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "errors.code.codeExpired",
  BANNED_USER: "errors.code.banned",
  USERNAME_IS_ALREADY_TAKEN: "errors.code.usernameTaken",
  USER_ALREADY_EXISTS: "errors.code.usernameTaken",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "errors.code.usernameTaken",
  USERNAME_TOO_SHORT: "errors.code.invalidUsername",
  USERNAME_TOO_LONG: "errors.code.invalidUsername",
  PASSWORD_TOO_SHORT: "errors.code.passwordLength",
  PASSWORD_TOO_LONG: "errors.code.passwordLength",
  YOU_CANNOT_BAN_YOURSELF: "errors.code.banSelf",
  TOTP_NOT_ENABLED: "errors.code.totpNotEnabled",
  TWO_FACTOR_NOT_ENABLED: "errors.code.totpNotEnabled",
  SESSION_EXPIRED: "errors.code.unauthorized",
  INVALID_ORIGIN: "errors.code.csrfRefused",
  MISSING_OR_NULL_ORIGIN: "errors.code.csrfRefused",
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: "errors.code.csrfRefused",
}

/** The keys a failure falls back to by its status. */
export const STATUS_TEXT = {
  network: "errors.network",
  rateLimited: "errors.rateLimited",
  server: "errors.server",
  unauthorized: "errors.code.unauthorized",
  forbidden: "errors.code.forbidden",
  unexpected: "errors.unexpected",
} as const

/** The numbers some sentences name (password and username lengths). */
export const ERROR_VARS = {
  passwordMin: PASSWORD_MIN,
  passwordMax: PASSWORD_MAX,
  usernameMin: USERNAME_MIN,
  usernameMax: USERNAME_MAX,
}

/** A failure reduced to what the table reads: the status (0 when no answer came) and the code. */
export function failureOf(error: unknown): { status: number; code: string } {
  if (error instanceof ApiError) return { status: error.status, code: error.code }
  if (error instanceof AuthCallError) return fromAuth(error.answer)
  if (error && typeof error === "object" && ("status" in error || "code" in error)) return fromAuth(error as AuthError)
  return { status: -1, code: "" }
}

function fromAuth(answer: AuthError): { status: number; code: string } {
  return { status: answer?.status ?? 0, code: (answer?.code ?? "").toUpperCase() }
}

/** The locale key that explains a failure. */
export function errorKey(error: unknown): string {
  const { status, code } = failureOf(error)
  if (status === 0 || code === "NETWORK" || code === "network") return STATUS_TEXT.network
  // Better Auth's limiter answers 429; its message is not a code to look up.
  if (status === 429 || code === "RATE_LIMITED") return STATUS_TEXT.rateLimited
  const known = ERROR_TEXT[code]
  if (known) return known
  if (code.startsWith("YOU_ARE_NOT_ALLOWED")) return STATUS_TEXT.forbidden
  if (status >= 500) return STATUS_TEXT.server
  if (status === 401) return STATUS_TEXT.unauthorized
  if (status === 403) return STATUS_TEXT.forbidden
  return STATUS_TEXT.unexpected
}

/** The sentence that explains a failure, in the current language. */
export function errorText(t: (key: string, vars?: Record<string, string | number>) => string, error: unknown): string {
  return t(errorKey(error), ERROR_VARS)
}

/** Whether the sign-in's second-factor step has expired: the page goes back to the password. */
export function challengeExpired(error: unknown): boolean {
  return errorKey(error) === "errors.code.codeExpired"
}

/** Whether a refused answer means what was typed is wrong (it is cleared), not that no answer came (it stays). */
export function answered(error: unknown): boolean {
  return failureOf(error).status > 0
}
