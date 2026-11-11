import { z } from "zod"
import { LOCALES } from "./locales.ts"

/**
 * Every setting the owner manages: its type, default, whether it is secret, and the environment variable that may
 * override it. An environment value wins over the stored one and locks the field in the UI. Later phases add their
 * settings here.
 */
export interface SettingDefinition<T> {
  /** Validates a value from the UI or the environment. */
  schema: z.ZodType<T>
  defaultValue: T
  /** Stored encrypted and never returned by the API. */
  secret: boolean
  /** The variable that overrides and locks this field. */
  env: string
  /** Parses the text of the environment variable. */
  fromEnv: (text: string) => unknown
}

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
