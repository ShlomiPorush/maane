import { Readable } from "node:stream"
import { parseScannerAddress } from "@maane/shared"
import NodeClam from "clamscan"

// The clamd client: the clamscan package, through its documented stream scan (zINSTREAM over TCP), ping, and version
// (requirements 3.3). This module only turns clamd's answer into a verdict; it never decides that a file is clean on
// its own. clamscan's `timeout` is an idle timeout on the connection: when it passes, the client ends its side and
// the scan settles once clamd closes (an answer that is not a verdict). A clamd that keeps a half-closed connection
// open without answering is not bounded by it; see "Scanner" in docs/project-foundation.md.

/** The idle time after which a file scan is given up: above clamd's MaxScanTime (120 s in docker/clamav/clamd.conf). */
export const SCAN_TIMEOUT_MS = 150_000
/** The idle time for the self-test, whose samples are tiny. */
export const SELF_TEST_TIMEOUT_MS = 15_000

export type Verdict =
  | { kind: "clean" }
  | { kind: "infected"; signature: string }
  | { kind: "not_fully_scanned"; signature: string }
  /** No answer that decides anything: refused, timed out, cut off, an error reply, or an alert without a name. */
  | { kind: "error" }

/** ClamAV's alerts for content it could not scan whole: encrypted files and archives, and its scan limits. */
const NOT_FULLY_SCANNED = /^Heuristics\.(Encrypted\.|Limits\.Exceeded)/

/**
 * What clamscan's result means. Only `isInfected === false` is clean; `null` (no verdict) is never clean, and an
 * alert counts only with a name. Of several names, a signature wins over a limits or encryption alert.
 */
export function verdictOf(result: { isInfected: boolean | null; viruses?: unknown }): Verdict {
  if (result.isInfected === false) return { kind: "clean" }
  if (result.isInfected !== true || !Array.isArray(result.viruses)) return { kind: "error" }
  const names = result.viruses.filter((name): name is string => typeof name === "string" && name.trim() !== "")
  const signature = names.find((name) => !NOT_FULLY_SCANNED.test(name.trim()))
  if (signature) return { kind: "infected", signature: signature.trim() }
  const alert = names[0]
  return alert ? { kind: "not_fully_scanned", signature: alert.trim() } : { kind: "error" }
}

/** The stream clamscan sends: the content in 64 KiB pieces, and one empty piece for empty content. */
function chunks(bytes: Uint8Array): Readable {
  const size = 64 * 1024
  const pieces: Buffer[] = []
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset < buffer.length; offset += size) pieces.push(buffer.subarray(offset, offset + size))
  if (pieces.length === 0) pieces.push(Buffer.alloc(0))
  return Readable.from(pieces)
}

async function client(address: string, timeoutMs: number): Promise<NodeClam> {
  const target = parseScannerAddress(address)
  if (!target) throw new Error("not a scanner address")
  return new NodeClam().init({
    clamscan: { active: false },
    clamdscan: {
      host: target.host,
      port: target.port,
      timeout: timeoutMs,
      // Only the daemon over TCP: never a local binary, and no connection test of its own (the self-test is ours).
      localFallback: false,
      bypassTest: true,
    },
    preference: "clamdscan",
  })
}

export interface Scanner {
  scan(address: string, bytes: Uint8Array, timeoutMs?: number): Promise<Verdict>
  /** clamd answers PING with PONG. */
  ping(address: string, timeoutMs?: number): Promise<boolean>
  /** clamd's version line, or null. */
  version(address: string, timeoutMs?: number): Promise<string | null>
}

export const clamdScanner: Scanner = {
  async scan(address, bytes, timeoutMs = SCAN_TIMEOUT_MS) {
    try {
      const clam = await client(address, timeoutMs)
      return verdictOf(await clam.scanStream(chunks(bytes)))
    } catch {
      return { kind: "error" }
    }
  },
  async ping(address, timeoutMs = SELF_TEST_TIMEOUT_MS) {
    try {
      const clam = await client(address, timeoutMs)
      const socket = await clam.ping()
      socket.end()
      return true
    } catch {
      return false
    }
  },
  async version(address, timeoutMs = SELF_TEST_TIMEOUT_MS) {
    try {
      const clam = await client(address, timeoutMs)
      const line = (await clam.getVersion()).replaceAll("\0", "").trim()
      return line ? line.slice(0, 200) : null
    } catch {
      return null
    }
  },
}
