import { z } from "zod"
import { isClientId, isMailbox, isTenantId } from "./intake.ts"
import { LOCALES } from "./locales.ts"

/**
 * Every setting the owner manages: its type, default, whether it is secret, and the environment variable that may
 * override it. An environment value wins over the stored one and locks the field in the UI. A setting without a
 * variable is stored only. Later phases add their settings here.
 */
export interface SettingDefinition<T> {
  /** Validates a value from the UI or the environment. */
  schema: z.ZodType<T>
  defaultValue: T
  /** Stored encrypted and never returned by the API. */
  secret: boolean
  /** The variable that overrides and locks this field, or null when no variable may set it. */
  env: string | null
  /** Parses the text of the environment variable. */
  fromEnv: ((text: string) => unknown) | null
}

/** Listening records what intake would do and opens no ticket; live opens tickets (requirements 6.2). */
export const INTAKE_MODES = ["listening", "live"] as const
export type IntakeMode = (typeof INTAKE_MODES)[number]

/**
 * What happens to a file while the scanner is unavailable (requirements 3.3): `block` keeps incoming files waiting
 * and scans them when the scanner is back; `allow` stores them marked "not scanned".
 */
export const SCANNER_POLICIES = ["block", "allow"] as const
export type ScannerPolicy = (typeof SCANNER_POLICIES)[number]

export const MEGABYTE = 1024 * 1024
/**
 * The bounds of files.maxBytes. ClamAV refuses a stream longer than its StreamMaxLength instead of scanning it, so
 * docker/clamav/clamd.conf sets that limit to this maximum, and an outside clamd must allow at least as much.
 */
export const FILES_MAX_BYTES_MIN = 1 * MEGABYTE
export const FILES_MAX_BYTES_MAX = 100 * MEGABYTE

/** The bounds of scanner.scanTimeoutSeconds. */
export const SCAN_TIMEOUT_MIN_SECONDS = 10
export const SCAN_TIMEOUT_MAX_SECONDS = 600

const HOST_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
const SCANNER_ADDRESS = new RegExp(`^(\\[[0-9A-Fa-f:.]{2,45}\\]|${HOST_LABEL}(?:\\.${HOST_LABEL})*):(\\d{1,5})$`)

/** A clamd address as `host:port` (a name, an IPv4 address, or an IPv6 address in brackets), or null. */
export function parseScannerAddress(text: string): { host: string; port: number } | null {
  const match = SCANNER_ADDRESS.exec(text)
  if (!match?.[1] || !match[2] || match[1].length > 253) return null
  const port = Number(match[2])
  if (port < 1 || port > 65535) return null
  return { host: match[1].replace(/^\[(.*)\]$/, "$1"), port }
}

/**
 * An entry of files.blockedTypes: a file name extension without its dot (`exe`), or a detected type (`application/
 * x-msdownload`, as file-type names it). Both in lower case.
 */
export const BLOCKED_TYPE = /^(?:[a-z0-9][a-z0-9_+-]{0,15}|[a-z]+\/[a-z0-9][a-z0-9.+-]{0,126})$/
export const BLOCKED_TYPES_MAX = 200

/** Lower case, without a leading dot, each entry once: how the UI and the environment write a list of blocked types. */
export function normalizeBlockedTypes(text: string): string[] {
  const entries = text
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean)
  return [...new Set(entries)]
}

/**
 * Executables and scripts, blocked like an infected file (requirements 3.3): by the file name's extension, and by
 * the type file-type detects from the content, so a renamed program is blocked too. Applies to the file itself, not to
 * the files inside an archive.
 */
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

/** A Graph setting's text: empty while it is not set, else what `valid` accepts. */
const graphText = (valid: (text: string) => boolean) => z.string().refine((text) => text === "" || valid(text))

/** The longest application secret Maane stores; Entra's are about 40 characters. */
export const GRAPH_SECRET_MAX = 1024

export const SETTINGS = {
  "general.defaultLocale": define({
    schema: z.enum(LOCALES),
    defaultValue: "he" as (typeof LOCALES)[number],
    secret: false,
    env: "MAANE_DEFAULT_LOCALE",
    fromEnv: (text) => text,
  }),
  "security.sessionDays": define({
    schema: z.number().int().min(1).max(90),
    defaultValue: 14,
    secret: false,
    env: "MAANE_SESSION_DAYS",
    fromEnv: (text) => Number(text),
  }),
  // No variable: the owner's operational switch. One stored row is the only truth the UI, the processing, and the
  // default-address rule read, and the first migration of phase 2 creates it, so it can be locked (FOR SHARE).
  "intake.mode": define({
    schema: z.enum(INTAKE_MODES),
    defaultValue: "listening" as IntakeMode,
    secret: false,
    env: null,
    fromEnv: null,
  }),
  // The clamd the worker scans with: the bundled clamav service, or the owner's own (docs/deployment.md lists what an
  // outside clamd must be configured with).
  "scanner.address": define({
    schema: z.string().refine((text) => parseScannerAddress(text) !== null),
    defaultValue: "clamav:3310",
    secret: false,
    env: "MAANE_SCANNER_ADDRESS",
    fromEnv: (text) => text,
  }),
  "scanner.unavailablePolicy": define({
    schema: z.enum(SCANNER_POLICIES),
    defaultValue: "block" as ScannerPolicy,
    secret: false,
    env: "MAANE_SCANNER_UNAVAILABLE_POLICY",
    fromEnv: (text) => text,
  }),
  /**
   * How long one file scan may take, from connecting to clamd to its answer, before Maane gives up on it and the
   * unavailable policy decides. Above clamd's MaxScanTime (120 s), so clamd's own limit answers first.
   */
  "scanner.scanTimeoutSeconds": define({
    schema: z.number().int().min(SCAN_TIMEOUT_MIN_SECONDS).max(SCAN_TIMEOUT_MAX_SECONDS),
    defaultValue: 150,
    secret: false,
    env: "MAANE_SCANNER_SCAN_TIMEOUT_SECONDS",
    fromEnv: (text) => Number(text),
  }),
  /** The largest file Maane scans and stores, in bytes. */
  "files.maxBytes": define({
    schema: z.number().int().min(FILES_MAX_BYTES_MIN).max(FILES_MAX_BYTES_MAX),
    defaultValue: 50 * MEGABYTE,
    secret: false,
    env: "MAANE_FILES_MAX_BYTES",
    fromEnv: (text) => Number(text),
  }),
  "files.blockedTypes": define({
    schema: z.array(z.string().regex(BLOCKED_TYPE)).max(BLOCKED_TYPES_MAX),
    defaultValue: [...DEFAULT_BLOCKED_TYPES],
    secret: false,
    env: "MAANE_FILES_BLOCKED_TYPES",
    fromEnv: normalizeBlockedTypes,
  }),
  // Microsoft Graph (plan 2.3): the Entra application that reads the intake mailbox, and the mailbox. Each may come from
  // a variable that locks its field. A tenant or mailbox change makes a new current intake source.
  "graph.tenantId": define({
    schema: graphText(isTenantId),
    defaultValue: "",
    secret: false,
    env: "MAANE_GRAPH_TENANT_ID",
    fromEnv: (text) => text.trim(),
  }),
  "graph.clientId": define({
    schema: graphText(isClientId),
    defaultValue: "",
    secret: false,
    env: "MAANE_GRAPH_CLIENT_ID",
    fromEnv: (text) => text.trim(),
  }),
  /** The application's client secret: stored encrypted, never returned. A variable that reads as an example is refused. */
  "graph.clientSecret": define({
    schema: z
      .string()
      .min(1)
      .max(GRAPH_SECRET_MAX)
      // One line, without white space at either end.
      .regex(/^\S(?:[^\r\n]*\S)?$/),
    defaultValue: "",
    secret: true,
    env: "MAANE_GRAPH_CLIENT_SECRET",
    fromEnv: (text) => text.trim(),
  }),
  /** The shared intake mailbox Maane reads (read only). */
  "graph.mailbox": define({
    schema: graphText(isMailbox),
    defaultValue: "",
    secret: false,
    env: "MAANE_GRAPH_MAILBOX",
    fromEnv: (text) => text.trim(),
  }),
} as const

export type SettingKey = keyof typeof SETTINGS
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[]

/** A setting as the API shows it. A secret's value is never returned: only whether it is set. */
export interface SettingView {
  key: SettingKey
  value: unknown
  secret: boolean
  /** For a secret: whether a value is stored or set by the environment. */
  set: boolean
  locked: boolean
  /** The variable that sets it, when locked. */
  variable: string | null
}
