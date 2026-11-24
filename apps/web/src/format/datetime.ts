export const APP_TIME_ZONE = "Asia/Jerusalem"

let uiLocale: "he" | "en" = "he"

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

export function formatTime(value: DateInput, { seconds = true }: { seconds?: boolean } = {}): string {
  const date = toDate(value)
  if (!date) return "-"
  const p = zonedParts(date)
  return `${writeDate(p)} ${writeClock(p, seconds)}`
}

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

const HOUR_MS = 3_600_000

export type ZonedInput = { date: string; time: string }

export function zonedInput(value: Date): ZonedInput {
  const p = zonedParts(value)
  return { date: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`, time: writeClock(p) }
}

function offsetAt(ms: number): number {
  const p = zonedParts(new Date(ms))
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}

export function zonedInstant(input: ZonedInput): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.date)
  const t = /^(\d{2}):(\d{2})$/.exec(input.time)
  if (!d || !t) return null
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]))
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

export function nextWholeHour(now: Date = new Date()): ZonedInput {
  return zonedInput(new Date(Math.ceil((now.getTime() + HOUR_MS) / HOUR_MS) * HOUR_MS))
}
