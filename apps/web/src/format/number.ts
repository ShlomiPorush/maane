// Counts with thousands separators in the UI language (v3 FW-3). The separator follows the UI language, not the
// browser's, so a figure reads the same on every device.

let numberFormat = new Intl.NumberFormat("he-IL")

export function setNumberLocale(language: "he" | "en"): void {
  numberFormat = new Intl.NumberFormat(language === "he" ? "he-IL" : "en-US")
}

export function formatNumber(value: number): string {
  return numberFormat.format(value)
}
