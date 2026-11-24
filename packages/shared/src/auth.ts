export const ROLES = ["admin", "agent"] as const
export type Role = (typeof ROLES)[number]

export const USERNAME_MIN = 3
export const USERNAME_MAX = 30
export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 128

export const SETUP_WINDOW_MS = 5 * 60_000

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

export function userEmail(username: string): string {
  return `${username.toLowerCase()}@maane.invalid`
}
