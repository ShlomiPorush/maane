import { z } from "zod"
import { isClientId, isMailbox, isTenantId } from "./intake.ts"
import { isLinkDomain, LINK_TRACKING, type LinkTracking } from "./links.ts"
import { LOCALES } from "./locales.ts"

export interface SettingDefinition<T> {
  schema: z.ZodType<T>
  defaultValue: T
  secret: boolean
  env?: { name: string; parse: (text: string) => unknown }
  generated?: boolean
}

export const SCANNER_POLICIES = ["block", "allow"] as const
export type ScannerPolicy = (typeof SCANNER_POLICIES)[number]

export const MEGABYTE = 1024 * 1024
export const FILES_MAX_BYTES_MIN = 1 * MEGABYTE
export const FILES_MAX_BYTES_MAX = 100 * MEGABYTE

export const SCAN_TIMEOUT_MIN_SECONDS = 10
export const SCAN_TIMEOUT_MAX_SECONDS = 600

const HOST_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
const SCANNER_ADDRESS = new RegExp(`^(\\[[0-9A-Fa-f:.]{2,45}\\]|${HOST_LABEL}(?:\\.${HOST_LABEL})*):(\\d{1,5})$`)

export function parseScannerAddress(text: string): { host: string; port: number } | null {
  const match = SCANNER_ADDRESS.exec(text)
  if (!match?.[1] || !match[2] || match[1].length > 253) return null
  const port = Number(match[2])
  if (port < 1 || port > 65535) return null
  return { host: match[1].replace(/^\[(.*)\]$/, "$1"), port }
}

export const BLOCKED_TYPE = /^(?:[a-z0-9][a-z0-9_+-]{0,15}|[a-z]+\/[a-z0-9][a-z0-9.+-]{0,126})$/
export const BLOCKED_TYPES_MAX = 200

export function normalizeBlockedTypes(text: string): string[] {
  const entries = text
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean)
  return [...new Set(entries)]
}

export const DEFAULT_BLOCKED_TYPES: readonly string[] = [
  "ade",
  "adp",
  "app",
  "appx",
  "apk",
  "bat",
  "chm",
  "cmd",
  "com",
  "cpl",
  "dll",
  "dmg",
  "exe",
  "gadget",
  "hta",
  "inf",
  "ins",
  "iso",
  "jar",
  "js",
  "jse",
  "lnk",
  "msc",
  "msi",
  "msix",
  "msp",
  "mst",
  "pif",
  "ps1",
  "psm1",
  "reg",
  "scf",
  "scr",
  "sct",
  "sh",
  "vb",
  "vbe",
  "vbs",
  "vhd",
  "vhdx",
  "ws",
  "wsc",
  "wsf",
  "wsh",
  "application/java-archive",
  "application/java-vm",
  "application/vnd.android.package-archive",
  "application/vnd.ms-htmlhelp",
  "application/x-apple-diskimage",
  "application/x-elf",
  "application/x-mach-binary",
  "application/x-ms-shortcut",
  "application/x-msdownload",
]

const define = <T>(definition: SettingDefinition<T>) => definition

const graphText = (valid: (text: string) => boolean) => z.string().refine((text) => text === "" || valid(text))

export const GRAPH_SECRET_MAX = 1024

export const SMTP_SECURITIES = ["starttls", "tls"] as const
export type SmtpSecurity = (typeof SMTP_SECURITIES)[number]
export const SMTP_TLS_PORTS: readonly number[] = [465, 8465, 443]

export function isHostName(text: string): boolean {
  return (
    text.length <= 253 &&
    (new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`).test(text) || /^[0-9A-Fa-f:.]{2,45}$/.test(text))
  )
}

const smtpText = (valid: (text: string) => boolean) => z.string().refine((text) => text === "" || valid(text))
const smtpPort = z.number().int().min(1).max(65535)
const smtpUser = z
  .string()
  .max(255)
  .regex(/^[^\r\n]*$/)
const secretText = z
  .string()
  .min(1)
  .max(GRAPH_SECRET_MAX)
  .regex(/^\S(?:[^\r\n]*\S)?$/)

export const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{43}$/

export const SETTINGS = {
  "general.defaultLocale": define({
    schema: z.enum(LOCALES),
    defaultValue: "he" as (typeof LOCALES)[number],
    secret: false,
    env: { name: "MAANE_DEFAULT_LOCALE", parse: (text) => text },
  }),
  "security.sessionDays": define({
    schema: z.number().int().min(1).max(90),
    defaultValue: 14,
    secret: false,
    env: { name: "MAANE_SESSION_DAYS", parse: (text) => Number(text) },
  }),
  "scanner.address": define({
    schema: z.string().refine((text) => parseScannerAddress(text) !== null),
    defaultValue: "clamav:3310",
    secret: false,
    env: { name: "MAANE_SCANNER_ADDRESS", parse: (text) => text },
  }),
  "scanner.unavailablePolicy": define({
    schema: z.enum(SCANNER_POLICIES),
    defaultValue: "block" as ScannerPolicy,
    secret: false,
    env: { name: "MAANE_SCANNER_UNAVAILABLE_POLICY", parse: (text) => text },
  }),
  "scanner.scanTimeoutSeconds": define({
    schema: z.number().int().min(SCAN_TIMEOUT_MIN_SECONDS).max(SCAN_TIMEOUT_MAX_SECONDS),
    defaultValue: 150,
    secret: false,
    env: { name: "MAANE_SCANNER_SCAN_TIMEOUT_SECONDS", parse: (text) => Number(text) },
  }),
  "files.maxBytes": define({
    schema: z.number().int().min(FILES_MAX_BYTES_MIN).max(FILES_MAX_BYTES_MAX),
    defaultValue: 50 * MEGABYTE,
    secret: false,
    env: { name: "MAANE_FILES_MAX_BYTES", parse: (text) => Number(text) },
  }),
  "files.blockedTypes": define({
    schema: z.array(z.string().regex(BLOCKED_TYPE)).max(BLOCKED_TYPES_MAX),
    defaultValue: [...DEFAULT_BLOCKED_TYPES],
    secret: false,
    env: { name: "MAANE_FILES_BLOCKED_TYPES", parse: normalizeBlockedTypes },
  }),
  "graph.tenantId": define({
    schema: graphText(isTenantId),
    defaultValue: "",
    secret: false,
    env: { name: "MAANE_GRAPH_TENANT_ID", parse: (text) => text.trim() },
  }),
  "graph.clientId": define({
    schema: graphText(isClientId),
    defaultValue: "",
    secret: false,
    env: { name: "MAANE_GRAPH_CLIENT_ID", parse: (text) => text.trim() },
  }),
  "graph.clientSecret": define({
    schema: z
      .string()
      .min(1)
      .max(GRAPH_SECRET_MAX)
      .regex(/^\S(?:[^\r\n]*\S)?$/),
    defaultValue: "",
    secret: true,
    env: { name: "MAANE_GRAPH_CLIENT_SECRET", parse: (text) => text.trim() },
  }),
  "graph.mailbox": define({
    schema: graphText(isMailbox),
    defaultValue: "",
    secret: false,
    env: { name: "MAANE_GRAPH_MAILBOX", parse: (text) => text.trim() },
  }),
  "smtp2go.host": define({
    schema: smtpText(isHostName),
    defaultValue: "mail.smtp2go.com",
    secret: false,
    env: { name: "MAANE_SMTP2GO_HOST", parse: (text) => text.trim() },
  }),
  "smtp2go.port": define({
    schema: smtpPort,
    defaultValue: 587,
    secret: false,
    env: { name: "MAANE_SMTP2GO_PORT", parse: (text) => Number(text) },
  }),
  "smtp2go.user": define({
    schema: smtpUser,
    defaultValue: "",
    secret: false,
    env: { name: "MAANE_SMTP2GO_USER", parse: (text) => text.trim() },
  }),
  "smtp2go.password": define({
    schema: secretText,
    defaultValue: "",
    secret: true,
    env: { name: "MAANE_SMTP2GO_PASSWORD", parse: (text) => text.trim() },
  }),
  "smtp2go.apiKey": define({
    schema: secretText,
    defaultValue: "",
    secret: true,
    env: { name: "MAANE_SMTP2GO_API_KEY", parse: (text) => text.trim() },
  }),
  "smtp2go.webhookPath": define({
    schema: z.string().regex(WEBHOOK_SECRET),
    defaultValue: "",
    secret: true,
    generated: true,
  }),
  "smtp2go.webhookToken": define({
    schema: z.string().regex(WEBHOOK_SECRET),
    defaultValue: "",
    secret: true,
    generated: true,
  }),
  "failover.host": define({
    schema: smtpText(isHostName),
    defaultValue: "",
    secret: false,
    env: { name: "MAANE_FAILOVER_HOST", parse: (text) => text.trim() },
  }),
  "failover.port": define({
    schema: smtpPort,
    defaultValue: 587,
    secret: false,
    env: { name: "MAANE_FAILOVER_PORT", parse: (text) => Number(text) },
  }),
  "failover.security": define({
    schema: z.enum(SMTP_SECURITIES),
    defaultValue: "starttls" as SmtpSecurity,
    secret: false,
    env: { name: "MAANE_FAILOVER_SECURITY", parse: (text) => text.trim().toLowerCase() },
  }),
  "failover.user": define({
    schema: smtpUser,
    defaultValue: "",
    secret: false,
    env: { name: "MAANE_FAILOVER_USER", parse: (text) => text.trim() },
  }),
  "failover.password": define({
    schema: secretText,
    defaultValue: "",
    secret: true,
    env: { name: "MAANE_FAILOVER_PASSWORD", parse: (text) => text.trim() },
  }),
  "mail.bounceAddress": define({
    schema: smtpText(isMailbox),
    defaultValue: "",
    secret: false,
    env: { name: "MAANE_BOUNCE_ADDRESS", parse: (text) => text.trim() },
  }),
  "links.tracking": define({
    schema: z.enum(LINK_TRACKING),
    defaultValue: "on" as LinkTracking,
    secret: false,
    env: { name: "MAANE_LINK_TRACKING", parse: (text) => text.trim().toLowerCase() },
  }),
  "links.domain": define({
    schema: z.string().refine((text) => text === "" || isLinkDomain(text)),
    defaultValue: "",
    secret: false,
    env: { name: "MAANE_LINK_DOMAIN", parse: (text) => text.trim().toLowerCase() },
  }),
} as const

export type SettingKey = keyof typeof SETTINGS
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[]

export interface SettingView {
  key: SettingKey
  value: unknown
  secret: boolean
  set: boolean
  locked: boolean
  variable: string | null
}
