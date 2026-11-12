// Every stable server code the UI must explain maps to its own sentence in both languages, and failures without a
// known code fall back by status: no answer, the rate limit, a server error. The server's English message never
// reaches the page.

import { MESSAGES } from "@maane/shared"
import { describe, expect, it } from "vitest"
import { translate } from "../i18n/i18n.tsx"
import { AuthCallError } from "./auth.ts"
import { ApiError, errorFrom } from "./client.ts"
import { answered, challengeExpired, ERROR_TEXT, errorKey, errorText } from "./errors.ts"

const leaf = (tree: unknown, key: string) =>
  typeof key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], tree) === "string"

/** The codes the server answers today (apps/server/src/http/app.ts and auth/auth.ts) and Better Auth's common ones. */
const SERVER_CODES = {
  api: ["unauthorized", "totp_required", "csrf_refused", "setting_locked", "setting_invalid", "setting_unknown"],
  auth: [
    "UNAUTHORIZED",
    "TOTP_REQUIRED",
    "BANNED",
    "SETUP_CLOSED",
    "INVALID_USERNAME",
    "INVALID_ROLE",
    "OWN_ROLE",
    "SETUP_ADMIN_PROTECTED",
    "INVALID_USERNAME_OR_PASSWORD",
    "INVALID_PASSWORD",
    "INVALID_CODE",
    "INVALID_BACKUP_CODE",
    "INVALID_TWO_FACTOR_COOKIE",
    "BANNED_USER",
    "USERNAME_IS_ALREADY_TAKEN",
  ],
}

describe("error texts", () => {
  it("maps every stable server code to a sentence of its own in both languages", () => {
    for (const code of [...SERVER_CODES.api, ...SERVER_CODES.auth]) {
      const key = ERROR_TEXT[code]
      expect(key, code).toBeDefined()
      expect(leaf(MESSAGES.en, key as string), `${code} en`).toBe(true)
      expect(leaf(MESSAGES.he, key as string), `${code} he`).toBe(true)
    }
  })

  it("reads Maane's API answers ({error}) and Better Auth's ({code, message})", () => {
    expect(errorKey(errorFrom(409, { error: "setting_locked", key: "general.defaultLocale" }))).toBe(
      "errors.code.settingLocked",
    )
    expect(errorFrom(409, { error: "setting_locked", key: "general.defaultLocale" }).details.key).toBe(
      "general.defaultLocale",
    )
    expect(errorKey(errorFrom(403, { error: "csrf_refused" }))).toBe("errors.code.csrfRefused")
    expect(errorKey({ status: 403, code: "SETUP_ADMIN_PROTECTED", message: "The first admin cannot be demoted" })).toBe(
      "errors.code.setupAdminProtected",
    )
    expect(errorKey(new AuthCallError({ status: 403, code: "OWN_ROLE" }))).toBe("errors.code.ownRole")
  })

  it("explains a rate limit, a lost connection and a server error by status", () => {
    expect(errorKey({ status: 429, message: "Too many requests. Please try again later." })).toBe("errors.rateLimited")
    expect(errorKey(new ApiError(429, "unknown"))).toBe("errors.rateLimited")
    expect(errorKey(new ApiError(0, "network"))).toBe("errors.network")
    expect(errorKey({ status: 0 })).toBe("errors.network")
    expect(errorKey(new AuthCallError({}))).toBe("errors.network")
    expect(errorKey(new ApiError(500, "internal"))).toBe("errors.server")
    expect(errorKey({ status: 502, code: "SOMETHING_NEW" })).toBe("errors.server")
    expect(errorKey({ status: 403, code: "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS" })).toBe("errors.code.forbidden")
    expect(errorKey({ status: 400, code: "SOMETHING_NEW" })).toBe("errors.unexpected")
  })

  it("never shows the server's own English message", () => {
    const t = (key: string, vars?: Record<string, string | number>) => translate("he", key, vars)
    const text = errorText(t, { status: 403, code: "OWN_ROLE", message: "An admin cannot change their own role." })
    expect(text).not.toContain("An admin cannot")
    expect(text).toBe(translate("he", "errors.code.ownRole"))
  })

  it("fills the password and username lengths into their sentences", () => {
    const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars)
    expect(errorText(t, { status: 400, code: "PASSWORD_TOO_SHORT" })).toMatch(/12.*128/)
  })

  it("tells an expired sign-in challenge and an answered refusal apart", () => {
    expect(challengeExpired({ status: 401, code: "INVALID_TWO_FACTOR_COOKIE" })).toBe(true)
    expect(challengeExpired({ status: 401, code: "INVALID_CODE" })).toBe(false)
    expect(answered({ status: 401, code: "INVALID_CODE" })).toBe(true)
    expect(answered({ status: 0 })).toBe(false)
  })
})
