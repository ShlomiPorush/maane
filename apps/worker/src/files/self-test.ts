import type { Db } from "@maane/server/db/client"
import { scannerCheck } from "@maane/server/db/schema"
import type { ScannerCheck } from "@maane/shared"
import { CLEAN_SAMPLE, ENCRYPTED_PDF, ENCRYPTED_ZIP, eicar } from "./samples.ts"
import { PROBE_DEADLINE_MS, SAMPLE_DEADLINE_MS, type Scanner, type Verdict } from "./scanner.ts"

export interface SelfTestResult {
  address: string
  ok: boolean
  failedCheck: ScannerCheck | null
  version: string | null
  checkedAt: Date
}

const ENCRYPTED = /^Heuristics\.Encrypted\./

const encrypted = (verdict: Verdict) => verdict.kind === "not_fully_scanned" && ENCRYPTED.test(verdict.signature)

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
  if (!(await scanner.ping(address, PROBE_DEADLINE_MS))) return result("connection", null)
  const version = await scanner.version(address, PROBE_DEADLINE_MS)
  for (const { check, sample, passes } of SAMPLE_CHECKS) {
    if (!passes(await scanner.scan(address, sample(), SAMPLE_DEADLINE_MS))) return result(check, version)
  }
  return result(null, version)
}

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

export function selfTestView(result: SelfTestResult) {
  return {
    address: result.address,
    ok: result.ok,
    failedCheck: result.failedCheck,
    version: result.version,
    checkedAt: result.checkedAt.toISOString(),
  }
}
