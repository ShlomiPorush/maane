import { randomBytes } from "node:crypto"
import { openDatabase } from "@maane/server/db/client"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { clamdScanner } from "../files/scanner.ts"
import { FileService, sha256Of } from "../files/service.ts"
import { FileStore } from "../files/store.ts"

const [url, dir, hex] = process.argv.slice(2)
if (!url || !dir || hex === undefined) throw new Error("usage: kill-writer <database url> <store dir> <hex>")
const database = openDatabase(url, 2)
const settings = new Settings(
  database.db,
  createSettingsCipher([{ version: 1, value: randomBytes(32).toString("hex") }]),
  {},
)
const files = new FileService({ db: database.db, settings, scanner: clamdScanner, store: new FileStore(dir) })
const bytes = Buffer.from(hex, "hex")
const outcome = {
  sha256: sha256Of(bytes),
  size: bytes.length,
  detectedType: "text/plain",
  status: "clean" as const,
  signature: null,
  scannedAt: new Date(),
}
await database.db.transaction(async (tx) => {
  await files.storeIn(tx, bytes, outcome)
  process.stdout.write("published\n")
  await new Promise(() => setInterval(() => {}, 1_000))
})
