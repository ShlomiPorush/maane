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
