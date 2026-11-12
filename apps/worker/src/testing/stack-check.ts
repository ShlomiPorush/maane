import { randomBytes } from "node:crypto"
import { stat } from "node:fs/promises"
import { loadConfig } from "@maane/server/config"
import { openDatabase } from "@maane/server/db/client"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { parseScannerAddress } from "@maane/shared"
import { ClamdError, scanStream } from "../files/clamd.ts"
import { ENCRYPTED_PDF, ENCRYPTED_ZIP, eicar } from "../files/samples.ts"
import { clamdScanner } from "../files/scanner.ts"
import { FileService } from "../files/service.ts"
import { FileStore } from "../files/store.ts"
import { nestedZip } from "./zip.ts"

// The file checks of the container stack (scripts/verify.sh), run in a container of the worker service, with its
// configuration, network, read-only root, and /data, against the real ClamAV: the self-test, EICAR, an encrypted ZIP,
// an encrypted PDF, and a file beyond a scan limit through the worker's file service, then a clean file stored under
// /data/files. It prints "stored <sha256>" for the script, which reads that file back from the server. Bundled by
// verify.sh into apps/worker/dist/stack-check; never part of the image.

let failed = false
const check = (ok: boolean, what: string) => {
  console.log(`    ${ok ? "ok" : "FAIL"}: ${what}`)
  if (!ok) failed = true
}

const config = loadConfig()
const database = openDatabase(config.databaseUrl, 2)
const settings = new Settings(database.db, createSettingsCipher(config.settingsKeys), config.overrides)
const files = new FileService({
  db: database.db,
  settings,
  scanner: clamdScanner,
  store: new FileStore(config.filesDir),
})

try {
  const selfTest = await files.selfTest()
  check(
    selfTest.ok,
    `self-test of ${selfTest.address} (${selfTest.version ?? "no version"}): ${selfTest.failedCheck ?? "passed"}`,
  )

  const cases = [
    { label: "EICAR", bytes: eicar(), name: "eicar.txt", status: "infected", signature: /eicar/i },
    {
      label: "an encrypted ZIP",
      bytes: ENCRYPTED_ZIP,
      name: "a.zip",
      status: "not_fully_scanned",
      signature: /^Heuristics\.Encrypted\.Zip$/,
    },
    {
      label: "an encrypted PDF",
      bytes: ENCRYPTED_PDF,
      name: "a.pdf",
      status: "not_fully_scanned",
      signature: /^Heuristics\.Encrypted\.PDF$/,
    },
    {
      label: "20 nested archives (MaxRecursion 17)",
      bytes: nestedZip(20),
      name: "deep.zip",
      status: "not_fully_scanned",
      signature: /^Heuristics\.Limits\.Exceeded\.MaxRecursion$/,
    },
  ] as const
  for (const item of cases) {
    const outcome = await files.scan(item.bytes, item.name)
    check(
      outcome.status === item.status && item.signature.test(outcome.signature ?? ""),
      `${item.label}: ${outcome.status} ${outcome.signature ?? ""}`.trim(),
    )
  }

  // A stream past StreamMaxLength (100M in docker/clamav/clamd.conf): clamd refuses it, and the client says so.
  const target = parseScannerAddress(selfTest.address)
  const overLimit = target
    ? await scanStream(target, Buffer.alloc(101 * 1024 * 1024), { deadlineMs: 60_000 }).then(
        () => "resolved",
        (error) => (error instanceof ClamdError ? error.code : "other error"),
      )
    : "no address"
  check(overLimit === "size_limit", `a stream over StreamMaxLength: ${overLimit}`)

  const infected = await files.scan(eicar(), "eicar.txt")
  const refused = await files.store(eicar(), infected).then(
    () => false,
    () => true,
  )
  const onDisk = await stat(files.storedPath(infected.sha256)).then(
    () => true,
    () => false,
  )
  check(refused && !onDisk, "infected content is refused by the store and is not on disk")

  const clean = Buffer.from(`Maane stack check ${randomBytes(8).toString("hex")}\n`, "utf8")
  const outcome = await files.scan(clean, "check.txt")
  check(outcome.status === "clean", `a text file: ${outcome.status}`)
  if (outcome.status === "clean") {
    const row = await files.store(clean, outcome)
    check(row.scanStatus === "clean", `stored under /data/files with its row (${row.detectedType})`)
    if (!failed) console.log(`stored ${outcome.sha256}`)
  }
} finally {
  await database.close()
}
process.exit(failed ? 1 : 0)
