import { z } from "zod"
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

const define = <T>(definition: SettingDefinition<T>) => definition

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
