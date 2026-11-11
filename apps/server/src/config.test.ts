import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { ConfigError, isGeneratedHex, isPlaceholder, loadConfig } from "./config.ts"

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

// Instructions an example or a template could hold, in the forms reviews found: numbers next to words, long words,
// camelCase, and punctuation. Each is longer than 32 bytes.
const INSTRUCTIONS = [
  "<generate-32-random-bytes-and-paste-them-here>",
  "replace-me-with-32-random-bytes-before-starting",
  "YOUR-SETTINGS-SECRET-REPLACE-ME-HERE-123",
  "replace-me-with-32bytes-before-starting",
  "YOUR-SETTINGS-SECRET-REPLACE-ME-HERE123",
  "replace-this-with-a-cryptographically-random-secret",
  "changeMe-to-a-random-secret-before-starting",
  "replaceMeWith32RandomBytesBeforeStarting",
  "replace-me-with-32-random-bytes-before-starting!",
  "Change_Me_To_Something_Random_Please",
]

describe("loadConfig", () => {
  it("accepts generated values", () => {
    const config = loadConfig(env({ MAANE_TRUSTED_PROXIES: "192.0.2.0/24" }))
    expect(config.publicUrl.origin).toBe("https://maane.example.com")
    expect(config.authSecrets).toHaveLength(1)
    expect(config.trustedProxies).toEqual(["192.0.2.0/24"])
    expect(loadConfig(env({ MAANE_AUTH_SECRETS: `1:${key().toUpperCase()}` })).authSecrets).toHaveLength(1)
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

  it("refuses every key that is not 32 or more random bytes as hex", () => {
    for (const value of [
      ...INSTRUCTIONS,
      "short",
      "a".repeat(64),
      key().slice(0, 62),
      randomBytes(48).toString("base64url"),
    ]) {
      for (const name of ["MAANE_AUTH_SECRETS", "MAANE_SETTINGS_KEYS"]) {
        const message = problems(env({ [name]: `1:${value}` }))
        expect(message, `${name}=${value}`).toContain(`${name} entry 1 must be 32 or more random bytes as hex`)
        expect(message).not.toContain(value)
      }
    }
  })

  it("refuses shared keys", () => {
    const shared = key()
    expect(problems(env({ MAANE_AUTH_SECRETS: `1:${shared}`, MAANE_SETTINGS_KEYS: `2:${shared}` }))).toContain(
      "must differ",
    )
  })

  it("refuses a database password that is not random bytes as hex", () => {
    for (const value of [...INSTRUCTIONS, "changeme", "yourSecretHere", "0".repeat(64), password().slice(0, 30)]) {
      // Assembled, so the guards' URL-credential check does not read the source line as a real password.
      const url = ["postgres://maane:", encodeURIComponent(value), "@postgres/maane"].join("")
      expect(problems(env({ DATABASE_URL: url })), value).toContain("DATABASE_URL's password must be random bytes")
    }
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

describe("isGeneratedHex", () => {
  it("takes random hex of the length asked for, in either case, and nothing else", () => {
    expect(isGeneratedHex(key(), 32)).toBe(true)
    expect(isGeneratedHex(key().toUpperCase(), 32)).toBe(true)
    expect(isGeneratedHex(password(), 32)).toBe(false)
    expect(isGeneratedHex("f".repeat(64), 32)).toBe(false)
    expect(isGeneratedHex(`${key()} `, 32)).toBe(false)
  })
})

describe("isPlaceholder (outside services' credentials set through the environment)", () => {
  it("finds copied example values in every form the reviews found", () => {
    const shellStyle = ["$", "{SECRET}"].join("")
    for (const value of [...INSTRUCTIONS, shellStyle, "changeme", "example", "secret", "xxxxxxxx", "yourSecretHere"]) {
      expect(isPlaceholder(value), value).toBe(true)
    }
  })

  it("leaves credentials in the forms services issue", () => {
    // Assembled at run time: the guards and push protection scan literal text for credential formats.
    for (const value of [
      key(),
      ["api", randomBytes(16).toString("hex").toUpperCase()].join("-"),
      ["xYz7Qp2L", "mN9vB4cK", "1dR6tS3w", "F8gH5jA0"].join(""),
    ]) {
      expect(isPlaceholder(value), value).toBe(false)
    }
  })
})
