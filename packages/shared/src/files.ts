// The words of file scanning that the server, the worker, and the UI share (plan 2.2, requirements 3.3).

/**
 * What scanning decided about one file:
 * - `clean`: a scanner that passed Maane's self-test found nothing.
 * - `infected`: the scanner found a signature; the file is never stored.
 * - `not_fully_scanned`: an encrypted file or archive, or one beyond a scan limit (`Heuristics.Encrypted.*`,
 *   `Heuristics.Limits.Exceeded*`); stored, but never treated as clean and never previewed.
 * - `blocked_type`: an executable or script by its extension or its detected type; never stored.
 * - `waiting`: the scanner is unavailable and the policy is `block`; never stored until a scan decides.
 * - `not_scanned`: the scanner is unavailable and the policy is `allow`; stored, never treated as clean.
 * - `unavailable`: a waiting file whose source message no longer exists when it is retried (phase 2.3).
 */
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

/** The statuses whose content is written to the store. Every other status leaves nothing on disk. */
export const STORED_STATUSES = ["clean", "not_fully_scanned", "not_scanned"] as const
export type StoredStatus = (typeof STORED_STATUSES)[number]

/**
 * The checks of the scanner self-test, in the order they run. `clean` is trusted only from a scanner that passed all
 * of them: it answers (`connection`), finds EICAR (`eicar`), alerts on an encrypted ZIP and an encrypted PDF
 * (`encrypted_zip`, `encrypted_pdf`), and finds nothing in harmless text (`clean`).
 */
export const SCANNER_CHECKS = ["connection", "eicar", "encrypted_zip", "encrypted_pdf", "clean"] as const
export type ScannerCheck = (typeof SCANNER_CHECKS)[number]

/** The latest self-test, as the Settings page shows it. */
export interface ScannerStatusView {
  address: string
  ok: boolean
  /** The first check that failed, when `ok` is false. */
  failedCheck: ScannerCheck | null
  /** clamd's version line, when it answered. */
  version: string | null
  checkedAt: string
}

/** A connection test the Settings page queued: where the worker is with it, and its self-test once done. */
export interface ScannerTestView {
  state: "queued" | "running" | "done" | "failed"
  result: ScannerStatusView | null
}
