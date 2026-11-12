import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { SYSTEM } from "@maane/server/audit"
import { auditLog, scannerCheck, storedFile } from "@maane/server/db/schema"
import { SHARDS } from "@maane/server/files/paths"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { createTestDatabase, testKey } from "@maane/server/testing/db"
import { MEGABYTE } from "@maane/shared"
import { eq, sql } from "drizzle-orm"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { MARKERS, refusedAddress, type StandInClamd, startStandInClamd } from "../testing/clamd.ts"
import { CLEAN_SAMPLE, ENCRYPTED_ZIP, eicar } from "./samples.ts"
import { clamdScanner } from "./scanner.ts"
import { auditBlockedPart, FileService, FileTooLargeError, type ScanOutcome, sha256Of } from "./service.ts"
import { FileStore, lockStoredFile } from "./store.ts"

let database: Awaited<ReturnType<typeof createTestDatabase>>
let clamd: StandInClamd
let dir: string
let settings: Settings
let files: FileService

beforeAll(async () => {
  database = await createTestDatabase()
  clamd = await startStandInClamd()
})
afterAll(async () => {
  await clamd.close()
  await database.drop()
})
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "maane-files-")), "files")
  settings = new Settings(database.db, createSettingsCipher([{ version: 1, value: testKey() }]), {})
  await settings.update(
    { "scanner.address": clamd.address, "scanner.unavailablePolicy": "block", "files.maxBytes": 50 * MEGABYTE },
    SYSTEM,
  )
  await database.db.delete(scannerCheck)
  await database.db.delete(storedFile)
  const store = new FileStore(dir)
  await store.prepare()
  files = new FileService({ db: database.db, settings, scanner: clamdScanner, store })
})
afterEach(async () => {
  await rm(join(dir, ".."), { recursive: true, force: true })
})

const utf8 = (text: string) => Buffer.from(text, "utf8")
const unique = (label: string) => utf8(`${label} ${randomBytes(8).toString("hex")}\n`)
/** Every name in the shard of this hash that belongs to it: the file and any writer's temporary file. */
const namesOf = async (sha256: string) =>
  (await readdir(join(dir, sha256.slice(0, 2)))).filter((name) => name.includes(sha256))
const rowOf = async (sha256: string) =>
  (await database.db.select().from(storedFile).where(eq(storedFile.sha256, sha256)))[0]
const age = async (path: string, days: number) => {
  const then = new Date(Date.now() - days * 24 * 60 * 60_000)
  await utimes(path, then, then)
}

describe("the store", () => {
  it("creates the store and its 256 shards at start, and again without harm", async () => {
    expect((await readdir(dir)).sort()).toEqual([...SHARDS])
    await writeFile(join(dir, "ab", "keep"), "x")
    await new FileStore(dir).prepare()
    expect((await readdir(dir)).length).toBe(256)
    expect(await readFile(join(dir, "ab", "keep"), "utf8")).toBe("x")
  })
})

describe("scanning and storing", () => {
  it("stores clean content under its hash with its row", async () => {
    const bytes = unique("hello")
    const outcome = await files.scan(bytes, "hello.txt")
    expect(outcome).toMatchObject({ status: "clean", detectedType: "text/plain", sha256: sha256Of(bytes) })
    const row = await files.store(bytes, outcome)
    expect(row).toMatchObject({ sha256: outcome.sha256, size: bytes.length, scanStatus: "clean", signature: null })
    const path = files.storedPath(outcome.sha256)
    expect(path).toBe(join(dir, outcome.sha256.slice(0, 2), outcome.sha256))
    expect((await readFile(path)).equals(bytes)).toBe(true)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await namesOf(outcome.sha256)).toEqual([outcome.sha256])
    // The same content again: one file, one row.
    await files.store(bytes, await files.scan(bytes, "again.txt"))
    expect(await namesOf(outcome.sha256)).toEqual([outcome.sha256])
    expect((await database.db.select().from(storedFile)).length).toBe(1)
  })

  it("stores content that is not fully scanned with its alert", async () => {
    const outcome = await files.scan(ENCRYPTED_ZIP, "archive.zip")
    expect(outcome).toMatchObject({ status: "not_fully_scanned", signature: "Heuristics.Encrypted.Zip" })
    const limits = await files.scan(unique(MARKERS.limits), "big.bin")
    expect(limits).toMatchObject({ status: "not_fully_scanned", signature: "Heuristics.Limits.Exceeded.MaxFileSize" })
    expect(await files.store(ENCRYPTED_ZIP, outcome)).toMatchObject({
      scanStatus: "not_fully_scanned",
      signature: "Heuristics.Encrypted.Zip",
      detectedType: "application/zip",
    })
  })

  it("never writes infected, blocked, or waiting content to disk", async () => {
    const infected = await files.scan(eicar(), "note.txt")
    expect(infected).toMatchObject({ status: "infected", signature: "Eicar-Test-Signature" })
    const blocked = await files.scan(unique("echo hi"), "run.bat")
    expect(blocked).toMatchObject({ status: "blocked_type", blockedBy: "bat" })
    // A program renamed as a picture is blocked by its detected type.
    const program = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200)])
    expect(await files.scan(program, "photo.jpg")).toMatchObject({
      status: "blocked_type",
      detectedType: "application/x-msdownload",
    })
    await settings.update({ "scanner.address": await refusedAddress() }, SYSTEM)
    const waiting = await files.scan(unique("later"), "later.txt")
    expect(waiting.status).toBe("waiting")
    for (const [outcome, bytes] of [
      [infected, eicar()],
      [blocked, unique("echo hi")],
      [waiting, unique("later")],
    ] as const) {
      await expect(files.store(bytes, outcome)).rejects.toThrow(/never stored/)
      expect(await namesOf(outcome.sha256)).toEqual([])
      expect(await rowOf(outcome.sha256)).toBeUndefined()
    }
  })

  it("refuses content that does not match its scan, and a file over files.maxBytes", async () => {
    const bytes = unique("one")
    const outcome = await files.scan(bytes, "one.txt")
    await expect(files.store(unique("two"), outcome)).rejects.toThrow(/does not match/)
    expect(await namesOf(outcome.sha256)).toEqual([])
    await settings.update({ "files.maxBytes": MEGABYTE }, SYSTEM)
    await expect(files.scan(Buffer.alloc(MEGABYTE + 1), "big.bin")).rejects.toBeInstanceOf(FileTooLargeError)
    expect(clamd.scanned.some((content) => content.length > MEGABYTE)).toBe(false)
  })
})

describe("the scanner contract", () => {
  it("trusts clean only from a scanner that passed the self-test", async () => {
    const lax = await startStandInClamd({ noEncryptedAlerts: true })
    try {
      await settings.update({ "scanner.address": lax.address }, SYSTEM)
      const outcome = await files.scan(CLEAN_SAMPLE, "note.txt")
      expect(outcome.status).toBe("waiting")
      const [status] = await database.db.select().from(scannerCheck)
      expect(status).toMatchObject({ address: lax.address, ok: false, failedCheck: "encrypted_zip" })
      // The scanner got EICAR and the encrypted ZIP, failed there, and never got the file itself.
      expect(lax.scanned).toHaveLength(2)
      // Right after a failed self-test, a scan does not test again; the policy decides at once.
      await settings.update({ "scanner.unavailablePolicy": "allow" }, SYSTEM)
      expect((await files.scan(CLEAN_SAMPLE, "note.txt")).status).toBe("not_scanned")
      expect(lax.scanned).toHaveLength(2)
    } finally {
      await lax.close()
    }
  })

  it("tests a new address before it trusts it", async () => {
    expect((await files.scan(unique("first"), "a.txt")).status).toBe("clean")
    const other = await startStandInClamd()
    try {
      await settings.update({ "scanner.address": other.address }, SYSTEM)
      expect((await files.scan(unique("second"), "b.txt")).status).toBe("clean")
      const [status] = await database.db.select().from(scannerCheck)
      expect(status).toMatchObject({ address: other.address, ok: true })
      // The self-test samples, then the file.
      expect(other.scanned.length).toBe(5)
    } finally {
      await other.close()
    }
  })

  it("does not let not scanned replace a scanner's answer", async () => {
    const bytes = unique("kept")
    await files.store(bytes, await files.scan(bytes, "kept.txt"))
    await settings.update({ "scanner.address": await refusedAddress(), "scanner.unavailablePolicy": "allow" }, SYSTEM)
    const later = await files.scan(bytes, "kept.txt")
    expect(later.status).toBe("not_scanned")
    expect(await files.store(bytes, later)).toMatchObject({ scanStatus: "clean" })
  })
})

describe("the audit row of a blocked file", () => {
  it("is written once, when the part becomes blocked, with no content", async () => {
    const outcome = await files.scan(eicar(), "invoice.pdf")
    const part = { ticketId: "t-1", messageId: "m-1", partId: "p-1", fileName: "invoice.pdf" }
    const before = (await database.db.select().from(auditLog)).length
    await database.db.transaction(async (tx) => {
      expect(await auditBlockedPart(tx, null, outcome, part)).toBe(true)
    })
    // A retry of the same part, already blocked, writes nothing.
    await database.db.transaction(async (tx) => {
      expect(await auditBlockedPart(tx, "infected", outcome, part)).toBe(false)
    })
    expect(await auditBlockedPart(database.db, "waiting", { ...outcome, status: "clean" } as ScanOutcome, part)).toBe(
      false,
    )
    const rows = (await database.db.select().from(auditLog)).slice(before)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      action: "file.blocked",
      actorLabel: "system",
      entityType: "message_part",
      entityId: "p-1",
      details: {
        ticket: "t-1",
        message: "m-1",
        part: "p-1",
        fileName: "invoice.pdf",
        reason: "infected",
        signature: "Eicar-Test-Signature",
        sha256: outcome.sha256,
      },
    })
    expect(JSON.stringify(rows[0]?.details)).not.toContain("EICAR")
  })
})

describe("the sweep", () => {
  it("removes old unreferenced files and temporary files, and keeps referenced and recent ones", async () => {
    const kept = unique("kept")
    const keptOutcome = await files.scan(kept, "kept.txt")
    await files.store(kept, keptOutcome)
    const orphan = unique("orphan")
    const orphanSha = sha256Of(orphan)
    await new FileStore(dir).write(orphanSha, orphan)
    const recent = unique("recent")
    const recentSha = sha256Of(recent)
    await new FileStore(dir).write(recentSha, recent)
    const temp = join(dir, orphanSha.slice(0, 2), `.${orphanSha}.${randomBytes(8).toString("hex")}.tmp`)
    await writeFile(temp, "partial")
    for (const path of [files.storedPath(keptOutcome.sha256), files.storedPath(orphanSha), temp]) await age(path, 2)

    expect(await files.sweep()).toEqual({ removed: 1, temporary: 1 })
    expect(await namesOf(orphanSha)).toEqual([])
    expect(await namesOf(keptOutcome.sha256)).toEqual([keptOutcome.sha256])
    expect(await namesOf(recentSha)).toEqual([recentSha])
  })

  it("waits for a writer that holds the hash's lock, then keeps the file it committed", async () => {
    const bytes = unique("racing")
    const sha256 = sha256Of(bytes)
    await new FileStore(dir).write(sha256, bytes)
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked = () => {}
    const holding = new Promise<void>((resolve) => {
      locked = resolve
    })
    const writer = database.db.transaction(async (tx) => {
      await lockStoredFile(tx, sha256)
      locked()
      await gate
      await tx
        .insert(storedFile)
        .values({ sha256, size: bytes.length, detectedType: "text/plain", scanStatus: "clean" })
    })
    await holding
    const sweeping = files.sweep(0)
    // The sweep found no row, and now waits for the writer's lock.
    await expect
      .poll(
        async () =>
          (
            await database.db.execute(
              sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`,
            )
          ).rows[0]?.n,
        { timeout: 10_000 },
      )
      .toBe(1)
    release()
    await writer
    expect(await sweeping).toEqual({ removed: 0, temporary: 0 })
    expect(await namesOf(sha256)).toEqual([sha256])
  })
})

describe("a crash between the rename and the commit", () => {
  it("leaves a file no row references, which the sweep removes", async () => {
    const out = await mkdtemp(join(tmpdir(), "maane-kill-writer-"))
    try {
      const script = join(out, "kill-writer.mjs")
      await build({
        entryPoints: [fileURLToPath(new URL("../testing/kill-writer.ts", import.meta.url))],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node26",
        outfile: script,
        logLevel: "silent",
        banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      })
      const bytes = unique("crash")
      const sha256 = sha256Of(bytes)
      const child = spawn(process.execPath, [script, database.url, dir, bytes.toString("hex")], {
        stdio: ["ignore", "pipe", "inherit"],
      })
      const exited = new Promise<NodeJS.Signals | null>((resolve) =>
        child.on("exit", (_code, signal) => resolve(signal)),
      )
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (data: Buffer) => {
          if (data.toString().includes("published")) resolve()
        })
        child.on("exit", () => reject(new Error("the writer ended before it published the file")))
      })
      child.kill("SIGKILL")
      expect(await exited).toBe("SIGKILL")

      expect((await readFile(files.storedPath(sha256))).equals(bytes)).toBe(true)
      expect(await rowOf(sha256)).toBeUndefined()
      // Not yet a day old: kept. Older: removed, under the lock the killed writer no longer holds.
      expect((await files.sweep()).removed).toBe(0)
      await age(files.storedPath(sha256), 2)
      expect((await files.sweep()).removed).toBe(1)
      expect(await namesOf(sha256)).toEqual([])
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})
