import en from "./locales/en.json" with { type: "json" }
import he from "./locales/he.json" with { type: "json" }

/** The UI and customer email languages. Hebrew is the default. */
export const LOCALES = ["he", "en"] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = "he"

export type Messages = typeof en

export const MESSAGES: Record<Locale, Messages> = { he, en }

/** The writing direction of a locale. */
export function direction(locale: Locale): "rtl" | "ltr" {
  return locale === "he" ? "rtl" : "ltr"
}
