import { parseScannerAddress } from "@maane/shared"
import { type ClamdTarget, ping, scanStream, version } from "./clamd.ts"

// The scanner as the file service sees it: Maane's clamd client (clamd.ts) and the verdict of each answer
// (requirements 3.3). This module never decides that a file is clean on its own: only clamd's `stream: OK` is clean.
// Every operation has a hard deadline (clamd.ts), so a scanner that stops answering costs at most that long; a job
// that awaits it, the self-test included, always finishes.

/** The default deadline of a file scan: above clamd's MaxScanTime (120 s in docker/clamav/clamd.conf), so clamd's own
 * limit answers first with Heuristics.Limits.Exceeded.MaxScanTime. Settings may change it (scanner.scanTimeoutSeconds). */
export const SCAN_DEADLINE_MS = 150_000
/** Ping and version. */
export const PROBE_DEADLINE_MS = 10_000
/** A self-test sample scan: the samples are tiny. */
export const SAMPLE_DEADLINE_MS = 15_000

export type Verdict =
  | { kind: "clean" }
  | { kind: "infected"; signature: string }
  | { kind: "not_fully_scanned"; signature: string }
  /** No answer that decides anything: refused, timed out, cut off, an error reply, or a reply clamd never gives. */
  | { kind: "error" }

/** ClamAV's alerts for content it could not scan whole: encrypted files and archives, and its scan limits. */
const NOT_FULLY_SCANNED = /^Heuristics\.(Encrypted\.|Limits\.Exceeded)/

/** What clamd's answer means: no signature is clean; an encryption or limits alert is not fully scanned. */
export function verdictOf(found: string | null): Verdict {
  if (found === null) return { kind: "clean" }
  const signature = found.trim()
  if (!signature) return { kind: "error" }
  return NOT_FULLY_SCANNED.test(signature) ? { kind: "not_fully_scanned", signature } : { kind: "infected", signature }
}

function targetOf(address: string): ClamdTarget {
  const target = parseScannerAddress(address)
  if (!target) throw new Error("not a scanner address")
  return target
}

export interface Scanner {
  scan(address: string, bytes: Uint8Array, deadlineMs?: number): Promise<Verdict>
  /** clamd answers PING with PONG. */
  ping(address: string, deadlineMs?: number): Promise<boolean>
  /** clamd's version line, or null. */
  version(address: string, deadlineMs?: number): Promise<string | null>
}

export const clamdScanner: Scanner = {
  async scan(address, bytes, deadlineMs = SCAN_DEADLINE_MS) {
    try {
      return verdictOf((await scanStream(targetOf(address), bytes, { deadlineMs })).found)
    } catch {
      return { kind: "error" }
    }
  },
  async ping(address, deadlineMs = PROBE_DEADLINE_MS) {
    try {
      await ping(targetOf(address), { deadlineMs })
      return true
    } catch {
      return false
    }
  },
  async version(address, deadlineMs = PROBE_DEADLINE_MS) {
    try {
      return await version(targetOf(address), { deadlineMs })
    } catch {
      return null
    }
  },
}
