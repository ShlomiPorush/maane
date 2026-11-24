import { parseScannerAddress } from "@maane/shared"
import { type ClamdTarget, ping, scanStream, version } from "./clamd.ts"

export const SCAN_DEADLINE_MS = 150_000
export const PROBE_DEADLINE_MS = 10_000
export const SAMPLE_DEADLINE_MS = 15_000

export type Verdict =
  | { kind: "clean" }
  | { kind: "infected"; signature: string }
  | { kind: "not_fully_scanned"; signature: string }
  | { kind: "error" }

const NOT_FULLY_SCANNED = /^Heuristics\.(Encrypted\.|Limits\.Exceeded)/

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
  ping(address: string, deadlineMs?: number): Promise<boolean>
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
