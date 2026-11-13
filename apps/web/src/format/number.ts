// Counts with thousands separators in the UI language (v3 FW-3). The separator follows the UI language, not the
// browser's, so a figure reads the same on every device.

let numberFormat = new Intl.NumberFormat("he-IL")
let numberLocale = "he-IL"

export function setNumberLocale(language: "he" | "en"): void {
  numberLocale = language === "he" ? "he-IL" : "en-US"
  numberFormat = new Intl.NumberFormat(numberLocale)
}

export function formatNumber(value: number): string {
  return numberFormat.format(value)
}

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const

/** A file size in the UI language: "12 kB", "3.4 MB" (powers of 1024, one decimal from a kilobyte on). */
export function formatBytes(size: number): string {
  let value = Math.max(0, size)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return new Intl.NumberFormat(numberLocale, {
    style: "unit",
    unit: UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value)
}
