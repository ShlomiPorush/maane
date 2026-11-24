import { DEFAULT_LOCALE, direction, type Locale, MESSAGES } from "@maane/shared"
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react"
import { setDateLocale } from "../format/datetime.ts"
import { formatNumber, setNumberLocale } from "../format/number.ts"

export type Language = Locale
export type Vars = Record<string, string | number>

export const LANGUAGE_KEY = "maane.language"

function lookup(tree: unknown, key: string): string | undefined {
  let node: unknown = tree
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === "string" ? node : undefined
}

export const FSI = String.fromCodePoint(0x2068)
export const PDI = String.fromCodePoint(0x2069)

function fill(text: string, vars?: Vars): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? `${FSI}${String(vars[name])}${PDI}` : match,
  )
}

export function translate(language: Language, key: string, vars?: Vars): string {
  const text = lookup(MESSAGES[language], key) ?? lookup(MESSAGES.en, key) ?? key
  return fill(text, vars)
}

export function translateCount(language: Language, key: string, count: number, vars?: Vars): string {
  const category = new Intl.PluralRules(language).select(count)
  const form = lookup(MESSAGES[language], `${key}.${category}`) !== undefined ? category : "other"
  return translate(language, `${key}.${form}`, { ...vars, count: formatNumber(count) })
}

export function storedLanguage(): Language | null {
  try {
    const value = localStorage.getItem(LANGUAGE_KEY)
    return value === "he" || value === "en" ? value : null
  } catch {
    return null
  }
}

export function applyLanguage(language: Language): void {
  document.documentElement.lang = language
  document.documentElement.dir = direction(language)
  setNumberLocale(language)
  setDateLocale(language)
}

type I18n = {
  language: Language
  dir: "rtl" | "ltr"
  setLanguage(language: Language): void
  followDefault(language: Language): void
  t(key: string, vars?: Vars): string
  tc(key: string, count: number, vars?: Vars): string
}

const I18nContext = createContext<I18n | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => {
    const initial = storedLanguage() ?? DEFAULT_LOCALE
    applyLanguage(initial)
    return initial
  })
  const setLanguage = useCallback((next: Language) => {
    try {
      localStorage.setItem(LANGUAGE_KEY, next)
    } catch {}
    applyLanguage(next)
    setLanguageState(next)
  }, [])
  const followDefault = useCallback((next: Language) => {
    if (storedLanguage() !== null) return
    applyLanguage(next)
    setLanguageState(next)
  }, [])
  const value = useMemo<I18n>(
    () => ({
      language,
      dir: direction(language),
      setLanguage,
      followDefault,
      t: (key, vars) => translate(language, key, vars),
      tc: (key, count, vars) => translateCount(language, key, count, vars),
    }),
    [language, setLanguage, followDefault],
  )
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  const value = useContext(I18nContext)
  if (!value) throw new Error("useI18n outside I18nProvider")
  return value
}
