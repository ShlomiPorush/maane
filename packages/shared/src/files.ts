export const SCAN_STATUSES = [
  "clean",
  "infected",
  "not_fully_scanned",
  "blocked_type",
  "waiting",
  "not_scanned",
  "unavailable",
] as const
export type ScanStatus = (typeof SCAN_STATUSES)[number]

export const STORED_STATUSES = ["clean", "not_fully_scanned", "not_scanned"] as const
export type StoredStatus = (typeof STORED_STATUSES)[number]

export const SCANNER_CHECKS = ["connection", "eicar", "encrypted_zip", "encrypted_pdf", "clean"] as const
export type ScannerCheck = (typeof SCANNER_CHECKS)[number]

export interface ScannerStatusView {
  address: string
  ok: boolean
  failedCheck: ScannerCheck | null
  version: string | null
  checkedAt: string
}

export interface ScannerTestView {
  state: "queued" | "running" | "done" | "failed"
  result: ScannerStatusView | null
}
