import { SETTINGS, type SettingKey } from "@maane/shared"

export type VersionedKey = { version: number; value: string }

export type ServerConfig = {
  port: number
  databaseUrl: string
  /**
   * Better Auth's versioned `secrets` (MAANE_AUTH_SECRETS, "2:new,1:old"): the first signs cookies and encrypts new
   * data (two-factor secrets among them), the others only decrypt. Each at least MIN_SECRET_BYTES bytes.
   */
  authSecrets: VersionedKey[]
  /** MAANE_SETTINGS_KEYS ("2:new,1:old"): encrypts the secrets stored in settings. Never an auth secret. */
  settingsKeys: VersionedKey[]
  /** MAANE_TRUSTED_PROXIES: the proxy addresses or CIDR ranges in front of Maane (Traefik), comma-separated. */
  trustedProxies: string[]
  /** MAANE_PUBLIC_URL: the URL people open; a browser's Origin must match it. */
  publicUrl: URL
  /** Where the server finds its migrations and the built UI. */
  migrationsDir: string
  webDir: string
  version: string
  /** Settings the environment sets: each overrides the stored value, and the UI shows the field locked. */
  overrides: Partial<Record<SettingKey, string>>
}

export const MIN_SECRET_BYTES = 32

/** Configuration that refuses to start. Its message names variables, never a value. */
export class ConfigError extends Error {
  override name = "ConfigError"
}

/** Variables Better Auth would read on its own when an option lacks a value. Maane refuses them. */
const FOREIGN_AUTH_VARIABLES = /^(BETTER_AUTH_|AUTH_SECRET$)/

/**
 * A value copied from an example instead of generated: in angle brackets or `${...}`, one character repeated, or a
 * phrase of words such as "changeme", "your-secret-here", "example", or "placeholder", the whole value matching.
 * The phrases hold only letters and separators, so a random value, which has digits or upper case, never matches.
 */
export function isPlaceholder(value: string): boolean {
  const v = value.trim()
  if (/^<.*>$/.test(v) || /^\$\{.*\}$/.test(v) || /^(.)\1*$/.test(v)) return true
  if (!/^[a-z _.-]+$/.test(v.toLowerCase()) || /[A-Z]/.test(v.slice(1))) return false
  const phrase = v.toLowerCase()
  return (
    /^(change[-_ .]?me|replace[-_ .]?me|your[-_ .][a-z_ .-]*|example[a-z_ .-]*|placeholder[a-z_ .-]*)$/.test(phrase) ||
    /^(secret|password|passw0rd|admin|test|dev|default|null|none|todo)$/.test(phrase) ||
    /(^|[-_ .])(change[-_ .]?me|replace[-_ .]?me|placeholder|example)([-_ .]|$)/.test(phrase)
  )
}

/**
 * Reads "2:new,1:old": versions are distinct non-negative integers, each value at least MIN_SECRET_BYTES bytes and
 * not a placeholder. Problems name the variable and the position, never a value.
 */
function parseKeys(name: string, text: string, problems: string[]): VersionedKey[] {
  const keys: VersionedKey[] = []
  const seen = new Set<number>()
  text.split(",").forEach((raw, index) => {
    const entry = raw.trim()
    const colon = entry.indexOf(":")
    const versionText = colon > 0 ? entry.slice(0, colon) : ""
    const value = colon > 0 ? entry.slice(colon + 1).trim() : ""
    const version = /^\d{1,6}$/.test(versionText) ? Number(versionText) : Number.NaN
    if (!Number.isInteger(version) || !value) {
      problems.push(`${name} entry ${index + 1} must look like <version>:<secret>`)
      return
    }
    if (seen.has(version)) problems.push(`${name} repeats version ${version}`)
    seen.add(version)
    if (Buffer.byteLength(value, "utf8") < MIN_SECRET_BYTES) {
      problems.push(`${name} entry ${index + 1} must be at least ${MIN_SECRET_BYTES} bytes (use 32 random bytes)`)
    } else if (isPlaceholder(value)) {
      problems.push(`${name} entry ${index + 1} is a placeholder; generate a random value`)
    }
    keys.push({ version, value })
  })
  return keys
}

/**
 * Reads the server and worker configuration from the environment and refuses an unsafe one. Only what a process
 * needs before it can read its own settings lives here alone: the database, the keys, the public URL, and the
 * proxy wiring. Settings the owner manages live in the database; a variable named in the settings registry
 * overrides the stored value of its field.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const problems: string[] = []
  const required = (name: string) => {
    const value = env[name]?.trim()
    if (!value) problems.push(`${name} is required`)
    return value ?? ""
  }

  for (const name of Object.keys(env).sort()) {
    if (FOREIGN_AUTH_VARIABLES.test(name) && env[name] !== undefined) {
      problems.push(`${name} is set: Better Auth would read it on its own; Maane uses MAANE_AUTH_SECRETS only`)
    }
  }

  const databaseUrl = required("DATABASE_URL")
  const publicUrlText = required("MAANE_PUBLIC_URL")
  const authSecretsText = required("MAANE_AUTH_SECRETS")
  const settingsKeysText = required("MAANE_SETTINGS_KEYS")
  const authSecrets = authSecretsText ? parseKeys("MAANE_AUTH_SECRETS", authSecretsText, problems) : []
  const settingsKeys = settingsKeysText ? parseKeys("MAANE_SETTINGS_KEYS", settingsKeysText, problems) : []
  const authValues = new Set(authSecrets.map((k) => k.value))
  if (settingsKeys.some((k) => authValues.has(k.value))) {
    problems.push("MAANE_SETTINGS_KEYS must differ from every auth secret")
  }

  let publicUrl: URL | undefined
  if (publicUrlText) {
    publicUrl = URL.canParse(publicUrlText) ? new URL(publicUrlText) : undefined
    if (!publicUrl || (publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:")) {
      problems.push("MAANE_PUBLIC_URL must be an http or https URL")
    }
  }

  if (databaseUrl) {
    const url = URL.canParse(databaseUrl) ? new URL(databaseUrl) : undefined
    if (!url || !/^postgres(ql)?:$/.test(url.protocol)) problems.push("DATABASE_URL must be a postgres:// URL")
    else if (!url.password) problems.push("DATABASE_URL must hold the database password")
    else if (isPlaceholder(decodeURIComponent(url.password))) {
      problems.push("DATABASE_URL holds a placeholder password; generate a random one")
    }
  }

  const trustedProxies = (env.MAANE_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  if (trustedProxies.some((p) => !/^[0-9A-Fa-f:.]+(\/\d{1,3})?$/.test(p))) {
    problems.push("MAANE_TRUSTED_PROXIES must be a comma-separated list of IP addresses or CIDR ranges")
  }

  const port = Number(env.PORT ?? 8080)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) problems.push("PORT must be a port number")

  const overrides: Partial<Record<SettingKey, string>> = {}
  for (const [key, setting] of Object.entries(SETTINGS) as [SettingKey, (typeof SETTINGS)[SettingKey]][]) {
    const value = env[setting.env]?.trim()
    if (!value) continue
    if (setting.secret && isPlaceholder(value)) problems.push(`${setting.env} is a placeholder`)
    else if (!setting.schema.safeParse(setting.fromEnv(value)).success) problems.push(`${setting.env} is not valid`)
    overrides[key] = value
  }

  if (problems.length > 0 || !publicUrl) throw new ConfigError(`Invalid configuration: ${problems.join("; ")}`)

  return {
    port,
    databaseUrl,
    authSecrets,
    settingsKeys,
    trustedProxies,
    publicUrl,
    migrationsDir: env.MAANE_MIGRATIONS_DIR || "drizzle",
    webDir: env.MAANE_WEB_DIR || "dist/web",
    version: env.MAANE_VERSION || "dev",
    overrides,
  }
}
