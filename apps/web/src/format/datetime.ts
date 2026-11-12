// The one place that writes dates and times (v3 FW-1, FW-9). Every time on screen is in Maane's time zone
// (Asia/Jerusalem), never the browser's, as numbers only: day/month/year and the 24-hour clock. A page never formats
// a date itself; guards.test.ts fails on toLocaleDateString, Intl.DateTimeFormat and the like outside this file.

export const APP_TIME_ZONE = "Asia/Jerusalem"

let uiLocale: "he" | "en" = "he"

/** The UI language: kept for the words around a date; the digits and their order are the same in both. */
export function setDateLocale(language: "he" | "en"): void {
  uiLocale = language
}

export function dateLocale(): "he" | "en" {
  return uiLocale
}

const parts = new Intl.DateTimeFormat("en-US", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})

export type DateInput = string | number | Date | null | undefined

export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** The wall clock of an instant in Maane's time zone. */
export function zonedParts(date: Date): Parts {
  const found = parts.formatToParts(date)
  const get = (type: string) => Number(found.find((part) => part.type === type)?.value ?? 0)
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  }
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0")

const writeDate = (p: Parts, year = true) => `${pad(p.day)}/${pad(p.month)}${year ? `/${pad(p.year, 4)}` : ""}`
const writeClock = (p: Parts, seconds = false) => `${pad(p.hour)}:${pad(p.minute)}${seconds ? `:${pad(p.second)}` : ""}`

/** Date and time: "23/10/2026 13:05:09" (seconds optional). */
export function formatTime(value: DateInput, { seconds = true }: { seconds?: boolean } = {}): string {
  const date = toDate(value)
  if (!date) return "-"
  const p = zonedParts(date)
  return `${writeDate(p)} ${writeClock(p, seconds)}`
}

/** A list row: the time today, day and month earlier this year, the whole date before (FW-1). */
export function formatListTime(value: DateInput, now: Date = new Date()): string {
  const date = toDate(value)
  if (!date) return "-"
  const p = zonedParts(date)
  const n = zonedParts(now)
  if (p.year === n.year && p.month === n.month && p.day === n.day) return writeClock(p)
  if (p.year === n.year) return `${writeDate(p, false)} ${writeClock(p)}`
  return `${writeDate(p)} ${writeClock(p)}`
}

export type Ago = { unit: "now" } | { unit: "min" | "h" | "d"; count: number }

/** How long ago, rounded: under a minute "now", under an hour minutes, under 48 hours hours, then days. */
export function agoParts(value: DateInput, now: Date = new Date()): Ago | null {
  const date = toDate(value)
  if (!date) return null
  const seconds = Math.max(0, (now.getTime() - date.getTime()) / 1000)
  if (seconds < 60) return { unit: "now" }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return { unit: "min", count: minutes }
  const hours = Math.round(seconds / 3600)
  if (hours < 48) return { unit: "h", count: hours }
  return { unit: "d", count: Math.round(seconds / 86_400) }
}
