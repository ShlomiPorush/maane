import { createECDH } from "node:crypto"
import { SETTINGS, type SettingKey } from "@maane/shared"

export type VersionedKey = { version: number; value: string }

export type VapidKeys = { publicKey: string; privateKey: string }

export type ServerConfig = {
  port: number
  databaseUrl: string
  authSecrets: VersionedKey[]
  settingsKeys: VersionedKey[]
  vapid: VapidKeys
  trustedProxies: string[]
  publicUrl: URL
  migrationsDir: string
  webDir: string
  filesDir: string
  geoipDir: string
  archiveDir: string
  version: string
  overrides: Partial<Record<SettingKey, string>>
}

export const MIN_SECRET_BYTES = 32
export const MIN_DATABASE_PASSWORD_BYTES = 16

export function isGeneratedHex(value: string, bytes: number): boolean {
  return value.length >= bytes * 2 && /^[0-9a-fA-F]+$/.test(value) && !/^(.)\1*$/.test(value)
}

export class ConfigError extends Error {
  override name = "ConfigError"
}

const FOREIGN_AUTH_VARIABLES = /^(BETTER_AUTH_|AUTH_SECRET$)/

const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set([
  "changeme",
  "change",
  "replaceme",
  "replace",
  "placeholder",
  "example",
  "your",
  "secret",
  "password",
  "todo",
  "fixme",
  "here",
  "dummy",
  "sample",
  "fake",
  "test",
  "dev",
  "default",
  "generate",
  "admin",
  "none",
  "null",
])

export function isPlaceholder(value: string): boolean {
  const v = value.trim()
  if (/^<.*>$/.test(v) || /^\$\{.*\}$/.test(v) || /^(.)\1*$/.test(v)) return true
  const words = v.split(/[^A-Za-z0-9]+|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])|(?<=[a-z])(?=[A-Z])/).filter(Boolean)
  if (!words.every((word) => /^(?:\d+|[a-z]+|[A-Z]+|[A-Z][a-z]+)$/.test(word))) return false
  return words.some((word) => PLACEHOLDER_WORDS.has(word.toLowerCase()))
}

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
    if (!isGeneratedHex(value, MIN_SECRET_BYTES)) {
      problems.push(
        `${name} entry ${index + 1} must be ${MIN_SECRET_BYTES} or more random bytes as hex (openssl rand -hex 32)`,
      )
    }
    keys.push({ version, value })
  })
  return keys
}

const BASE64URL = /^[A-Za-z0-9_-]+$/
const VAPID_NAMES = "MAANE_VAPID_PUBLIC_KEY and MAANE_VAPID_PRIVATE_KEY"

export function vapidProblem(publicKey: string, privateKey: string): string | null {
  const shape = `${VAPID_NAMES} must be the key pair web-push's generateVAPIDKeys makes`
  if (!BASE64URL.test(publicKey) || !BASE64URL.test(privateKey)) return shape
  const pub = Buffer.from(publicKey, "base64url")
  const priv = Buffer.from(privateKey, "base64url")
  if (pub.length !== 65 || priv.length !== 32 || pub[0] !== 4) return shape
  try {
    const curve = createECDH("prime256v1")
    curve.setPrivateKey(priv)
    return curve.getPublicKey().equals(pub) ? null : `${VAPID_NAMES} are not one key pair`
  } catch {
    return shape
  }
}

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
  const vapidPublic = required("MAANE_VAPID_PUBLIC_KEY")
  const vapidPrivate = required("MAANE_VAPID_PRIVATE_KEY")
  const vapid = vapidPublic && vapidPrivate ? vapidProblem(vapidPublic, vapidPrivate) : null
  if (vapid) problems.push(vapid)
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
    else if (!isGeneratedHex(decodeURIComponent(url.password), MIN_DATABASE_PASSWORD_BYTES)) {
      problems.push("DATABASE_URL's password must be random bytes as hex (openssl rand -hex 32)")
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
    if (!setting.env) continue
    const { name, parse } = setting.env
    const value = env[name]?.trim()
    if (!value) continue
    if (setting.secret && isPlaceholder(value)) problems.push(`${name} is a placeholder`)
    else if (!setting.schema.safeParse(parse(value)).success) problems.push(`${name} is not valid`)
    overrides[key] = value
  }

  if (problems.length > 0 || !publicUrl) throw new ConfigError(`Invalid configuration: ${problems.join("; ")}`)

  return {
    port,
    databaseUrl,
    authSecrets,
    settingsKeys,
    vapid: { publicKey: vapidPublic, privateKey: vapidPrivate },
    trustedProxies,
    publicUrl,
    migrationsDir: env.MAANE_MIGRATIONS_DIR || "drizzle",
    webDir: env.MAANE_WEB_DIR || "dist/web",
    filesDir: env.MAANE_FILES_DIR || "/data/files",
    geoipDir: "/geoip",
    archiveDir: env.MAANE_ZENDESK_ARCHIVE_DIR?.trim() || "/zendesk-archive",
    version: env.MAANE_VERSION || "dev",
    overrides,
  }
}
