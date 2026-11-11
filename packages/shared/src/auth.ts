/** The two roles. A user has exactly one. */
export const ROLES = ["admin", "agent"] as const
export type Role = (typeof ROLES)[number]

export const USERNAME_MIN = 3
export const USERNAME_MAX = 30
export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 128

/** How long the setup screen stays open after the server starts. */
export const SETUP_WINDOW_MS = 5 * 60_000

/**
 * A username: 3 to 30 lowercase letters, digits, underscores, and dots, with no dot first, last, or next to another.
 * The same rule serves Better Auth's documented `usernameValidator`, so the synthetic e-mail is readable.
 */
export function isValidUsername(name: string): boolean {
  return (
    name.length >= USERNAME_MIN &&
    name.length <= USERNAME_MAX &&
    /^[a-z0-9_.]+$/.test(name) &&
    !name.startsWith(".") &&
    !name.endsWith(".") &&
    !name.includes("..")
  )
}

/** The e-mail Better Auth requires for each user. `.invalid` is reserved (RFC 2606): nothing is ever sent to it. */
export function userEmail(username: string): string {
  return `${username.toLowerCase()}@maane.invalid`
}
