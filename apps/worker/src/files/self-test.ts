import type { Db } from "@maane/server/db/client"
import { scannerCheck } from "@maane/server/db/schema"
import type { ScannerCheck } from "@maane/shared"
import { CLEAN_SAMPLE, ENCRYPTED_PDF, ENCRYPTED_ZIP, eicar } from "./samples.ts"
import { type Scanner, SELF_TEST_TIMEOUT_MS, type Verdict } from "./scanner.ts"

// The scanner contract (plan 2.2, P15): "clean" is trusted only from a scanner that passed this self-test. It runs on
// worker start, every hour, when the scanner address changes, and for a connection test from Settings. A scanner that
// fails it counts as unavailable, and the Settings page names the check that failed.

export interface SelfTestResult {
  address: string
  ok: boolean
  failedCheck: ScannerCheck | null
  version: string | null
  checkedAt: Date
}

const ENCRYPTED = /^Heuristics\.Encrypted\./

const encrypted = (verdict: Verdict) => verdict.kind === "not_fully_scanned" && ENCRYPTED.test(verdict.signature)

/** The sample checks after `connection`, in the order of SCANNER_CHECKS: each sample and the verdict it needs. */
export const SAMPLE_CHECKS: readonly {
  check: ScannerCheck
  sample: () => Uint8Array
  passes: (v: Verdict) => boolean
}[] = [
  { check: "eicar", sample: eicar, passes: (verdict) => verdict.kind === "infected" },
  { check: "encrypted_zip", sample: () => ENCRYPTED_ZIP, passes: encrypted },
  { check: "encrypted_pdf", sample: () => ENCRYPTED_PDF, passes: encrypted },
  { check: "clean", sample: () => CLEAN_SAMPLE, passes: (verdict) => verdict.kind === "clean" },
]

/** Runs every check in order against `address` and stops at the first that fails. Writes nothing. */
export async function runSelfTest(
  scanner: Scanner,
  address: string,
  now: () => Date = () => new Date(),
): Promise<SelfTestResult> {
  const result = (failedCheck: ScannerCheck | null, version: string | null): SelfTestResult => ({
    address,
    ok: failedCheck === null,
    failedCheck,
    version,
    checkedAt: now(),
  })
  if (!(await scanner.ping(address, SELF_TEST_TIMEOUT_MS))) return result("connection", null)
  const version = await scanner.version(address, SELF_TEST_TIMEOUT_MS)
  for (const { check, sample, passes } of SAMPLE_CHECKS) {
    if (!passes(await scanner.scan(address, sample(), SELF_TEST_TIMEOUT_MS))) return result(check, version)
  }
  return result(null, version)
}

/** Keeps the result as the scanner's current status: the one row the file service and the Settings page read. */
export async function recordSelfTest(db: Pick<Db, "insert">, result: SelfTestResult): Promise<void> {
  const row = {
    address: result.address,
    ok: result.ok,
    failedCheck: result.failedCheck,
    version: result.version,
    checkedAt: result.checkedAt,
  }
  await db
    .insert(scannerCheck)
    .values({ id: 1, ...row })
    .onConflictDoUpdate({ target: scannerCheck.id, set: row })
}

/** The status as the server shows it and the queue keeps it as a job's output. */
export function selfTestView(result: SelfTestResult) {
  return {
    address: result.address,
    ok: result.ok,
    failedCheck: result.failedCheck,
    version: result.version,
    checkedAt: result.checkedAt.toISOString(),
  }
}
