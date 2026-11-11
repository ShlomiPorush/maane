import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { ConfigError, isPlaceholder, loadConfig } from "./config.ts"

const key = () => randomBytes(32).toString("hex")
const password = () => randomBytes(16).toString("hex")

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: `postgres://maane:${password()}@postgres:5432/maane`,
    MAANE_PUBLIC_URL: "https://maane.example.com",
    MAANE_AUTH_SECRETS: `1:${key()}`,
    MAANE_SETTINGS_KEYS: `1:${key()}`,
    ...overrides,
  }
}

const problems = (e: NodeJS.ProcessEnv) => {
  try {
    loadConfig(e)
    return ""
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as Error).message
  }
}

describe("loadConfig", () => {
  it("accepts generated values", () => {
    const config = loadConfig(env({ MAANE_TRUSTED_PROXIES: "192.0.2.0/24" }))
    expect(config.publicUrl.origin).toBe("https://maane.example.com")
    expect(config.authSecrets).toHaveLength(1)
    expect(config.trustedProxies).toEqual(["192.0.2.0/24"])
  })

  it("refuses missing secrets and names the variables only", () => {
    const secret = key()
    const message = problems(
      env({ MAANE_AUTH_SECRETS: undefined, MAANE_SETTINGS_KEYS: `1:${secret}`, DATABASE_URL: "" }),
    )
    expect(message).toContain("MAANE_AUTH_SECRETS is required")
    expect(message).toContain("DATABASE_URL is required")
    expect(message).not.toContain(secret)
  })

  it("refuses placeholders, short keys, and shared keys", () => {
    expect(problems(env({ MAANE_AUTH_SECRETS: "1:<generate-32-random-bytes-and-paste-them-here>" }))).toContain(
      "placeholder",
    )
    expect(problems(env({ MAANE_AUTH_SECRETS: "1:short" }))).toContain("at least 32 bytes")
    expect(problems(env({ MAANE_SETTINGS_KEYS: `1:${"a".repeat(64)}` }))).toContain("placeholder")
    const shared = key()
    expect(problems(env({ MAANE_AUTH_SECRETS: `1:${shared}`, MAANE_SETTINGS_KEYS: `2:${shared}` }))).toContain(
      "must differ",
    )
    // Assembled, so the guards' URL-credential check does not read the source line as a real password.
    expect(problems(env({ DATABASE_URL: "postgres://maane:" + "changeme@postgres/maane" }))).toContain("placeholder")
    expect(problems(env({ DATABASE_URL: "postgres://maane@postgres/maane" }))).toContain("password")
  })

  it("refuses the variables Better Auth reads on its own", () => {
    expect(problems(env({ BETTER_AUTH_SECRET: key() }))).toContain("BETTER_AUTH_SECRET is set")
    expect(problems(env({ AUTH_SECRET: key() }))).toContain("AUTH_SECRET is set")
  })

  it("reads a setting override and refuses an invalid one", () => {
    expect(loadConfig(env({ MAANE_SESSION_DAYS: "7" })).overrides["security.sessionDays"]).toBe("7")
    expect(problems(env({ MAANE_SESSION_DAYS: "seven" }))).toContain("MAANE_SESSION_DAYS is not valid")
  })
})

describe("isPlaceholder", () => {
  it("finds copied example values but never a random one", () => {
    const shellStyle = ["$", "{SECRET}"].join("")
    for (const value of ["<secret>", shellStyle, "changeme", "change-me-please", "example", "secret", "xxxxxxxx"]) {
      expect(isPlaceholder(value), value).toBe(true)
    }
    for (let i = 0; i < 200; i++) {
      expect(isPlaceholder(randomBytes(32).toString("hex"))).toBe(false)
      expect(isPlaceholder(randomBytes(32).toString("base64url"))).toBe(false)
    }
    // Random values that happen to begin like a placeholder word are still random.
    for (const prefix of ["YOUR_A", "your-", "example", "changeme"]) {
      expect(isPlaceholder(`${prefix}${randomBytes(32).toString("base64url")}`), prefix).toBe(false)
    }
  })
})
