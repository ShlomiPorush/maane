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

// --- Entering a time in Maane's zone (plan 4.2: send later, snooze) ---

const HOUR_MS = 3_600_000

/** A date and a time as the date and time inputs hold them: "2026-11-15" and "09:30", in Maane's zone. */
export type ZonedInput = { date: string; time: string }

/** The date and time inputs' values for an instant, in Maane's zone, whatever the browser's zone. */
export function zonedInput(value: Date): ZonedInput {
  const p = zonedParts(value)
  return { date: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`, time: writeClock(p) }
}

/** How far Maane's zone is ahead of UTC at an instant, in milliseconds (daylight saving included). */
function offsetAt(ms: number): number {
  const p = zonedParts(new Date(ms))
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}

/**
 * The instant a date and a time name in Maane's zone (Asia/Jerusalem), whatever the browser's zone. Null when the
 * input is not a real date and time, or when that time does not exist in Israel (the hour the clock skips when daylight
 * saving starts). In the hour that repeats when it ends, the first of the two (still daylight saving time).
 */
export function zonedInstant(input: ZonedInput): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.date)
  const t = /^(\d{2}):(\d{2})$/.exec(input.time)
  if (!d || !t) return null
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]))
  // The zone's offset a day before and a day after covers both sides of any change; a candidate counts only when its
  // wall clock in the zone is the one asked for.
  const candidates = [...new Set([offsetAt(wall - 24 * HOUR_MS), offsetAt(wall + 24 * HOUR_MS)])]
    .map((offset) => wall - offset)
    .filter((ms) => {
      const back = zonedInput(new Date(ms))
      return back.date === input.date && back.time === input.time
    })
    .sort((a, b) => a - b)
  const first = candidates[0]
  return first === undefined ? null : new Date(first)
}

/** A sensible first choice for a time ahead: the next whole hour at least an hour from now, in Maane's zone. */
export function nextWholeHour(now: Date = new Date()): ZonedInput {
  return zonedInput(new Date(Math.ceil((now.getTime() + HOUR_MS) / HOUR_MS) * HOUR_MS))
}
