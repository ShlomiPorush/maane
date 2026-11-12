import { createHash } from "node:crypto"
import { SYSTEM, writeAudit } from "@maane/server/audit"
import type { Db } from "@maane/server/db/client"
import { scannerCheck, storedFile } from "@maane/server/db/schema"
import { log } from "@maane/server/log"
import type { Settings } from "@maane/server/settings/service"
import { type ScanStatus, STORED_STATUSES, type StoredStatus } from "@maane/shared"
import { eq } from "drizzle-orm"
import { type DetectedType, detectType } from "./detect.ts"
import type { Scanner } from "./scanner.ts"
import { recordSelfTest, runSelfTest, type SelfTestResult } from "./self-test.ts"
import { type FileStore, lockStoredFile, type WriteHooks } from "./store.ts"
import type { Tx } from "./types.ts"

// The file service the worker calls (plan 2.2): scan bytes, store scanned content under its hash's lock, and sweep
// the files no row references. Intake (2.3) and preview (2.4) build on it. It never writes infected, blocked, or
// waiting content to disk, and it never calls a file clean unless a scanner that passed the self-test said so.

/** A self-test older than this is run again before a scan trusts it (the hourly schedule normally keeps it fresh). */
export const SELF_TEST_MAX_AGE_MS = 2 * 60 * 60_000
/** After a failed self-test, scans count the scanner as unavailable for this long before they test it again. */
export const SELF_TEST_RETRY_MS = 60_000
/** The sweep removes an unreferenced file only once it is older than this. */
export const SWEEP_AGE_MS = 24 * 60 * 60_000

/** What scanning decided about one file. Nothing is written until `store` is called with it. */
export type ScanOutcome = { sha256: string; size: number; detectedType: string } & (
  | { status: "clean"; signature: null; scannedAt: Date }
  | { status: "not_fully_scanned"; signature: string; scannedAt: Date }
  | { status: "not_scanned"; signature: null; scannedAt: null }
  | { status: "infected"; signature: string; scannedAt: Date }
  | { status: "blocked_type"; blockedBy: string; signature: null; scannedAt: null }
  | { status: "waiting"; signature: null; scannedAt: null }
)

/**
 * A file larger than files.maxBytes. Never scanned and never stored; plan 2.2 has no status for it, so the caller
 * decides what its message records (phase 2.3).
 */
export class FileTooLargeError extends Error {
  override name = "FileTooLargeError"
  readonly code = "file_too_large"
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super("file_too_large")
  }
}

export const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/**
 * The entry of the blocked list a file matches, or null: its name's extension (trailing dots and spaces ignored, as
 * Windows ignores them), its detected type, or the extension of its detected type, so a renamed program is blocked.
 */
export function blockedBy(blocked: readonly string[], fileName: string | null, detected: DetectedType): string | null {
  const list = new Set(blocked)
  const name = (fileName ?? "").trim().replace(/[.\s]+$/, "")
  const dot = name.lastIndexOf(".")
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ""
  if (extension && list.has(extension)) return extension
  if (list.has(detected.mime)) return detected.mime
  if (detected.ext && list.has(detected.ext)) return detected.ext
  return null
}

export interface FileServiceOptions {
  db: Db
  settings: Settings
  scanner: Scanner
  store: FileStore
  now?: () => Date
}

export class FileService {
  readonly #db: Db
  readonly #settings: Settings
  readonly #scanner: Scanner
  readonly #store: FileStore
  readonly #now: () => Date

  constructor(options: FileServiceOptions) {
    this.#db = options.db
    this.#settings = options.settings
    this.#scanner = options.scanner
    this.#store = options.store
    this.#now = options.now ?? (() => new Date())
  }

  /** Where the file of this hash lives in the store. */
  storedPath(sha256: string): string {
    return this.#store.path(sha256)
  }

  /** Runs the self-test against the address in effect and keeps the result as the scanner's status. */
  async selfTest(): Promise<SelfTestResult> {
    const address = await this.#settings.get("scanner.address")
    const result = await runSelfTest(this.#scanner, address, this.#now)
    await recordSelfTest(this.#db, result)
    if (result.ok) log.info("scanner self-test passed", { version: result.version })
    else log.warn("scanner self-test failed", { failedCheck: result.failedCheck })
    return result
  }

  /**
   * The address of a scanner whose "clean" may be trusted, or null. Trusted means the latest self-test is of this
   * very address, passed, and is recent; otherwise the self-test runs now, except right after a failed one.
   */
  async trustedScanner(): Promise<string | null> {
    const address = await this.#settings.get("scanner.address")
    const [status] = await this.#db.select().from(scannerCheck).where(eq(scannerCheck.id, 1))
    const age = status ? this.#now().getTime() - status.checkedAt.getTime() : Number.POSITIVE_INFINITY
    if (status?.address === address && age >= 0 && age < SELF_TEST_MAX_AGE_MS) {
      if (status.ok) return address
      if (age < SELF_TEST_RETRY_MS) return null
    }
    const result = await this.selfTest()
    return result.ok && result.address === address ? address : null
  }

  /**
   * Decides about one file and writes nothing: the size limit, then the blocked types (by the declared name and by
   * the content), then the scanner. While no trusted scanner answers, the unavailable policy decides: `block` makes
   * the file wait, `allow` lets it be stored as not scanned.
   */
  async scan(bytes: Uint8Array, fileName: string | null): Promise<ScanOutcome> {
    const limit = await this.#settings.get("files.maxBytes")
    if (bytes.byteLength > limit) throw new FileTooLargeError(bytes.byteLength, limit)
    const base = { sha256: sha256Of(bytes), size: bytes.byteLength }
    const detected = await detectType(bytes)
    const facts = { ...base, detectedType: detected.mime }
    const blocked = blockedBy(await this.#settings.get("files.blockedTypes"), fileName, detected)
    if (blocked) return { ...facts, status: "blocked_type", blockedBy: blocked, signature: null, scannedAt: null }

    const address = await this.trustedScanner()
    if (address) {
      const verdict = await this.#scanner.scan(address, bytes)
      const scannedAt = this.#now()
      if (verdict.kind === "clean") return { ...facts, status: "clean", signature: null, scannedAt }
      if (verdict.kind === "infected") return { ...facts, status: "infected", signature: verdict.signature, scannedAt }
      if (verdict.kind === "not_fully_scanned")
        return { ...facts, status: "not_fully_scanned", signature: verdict.signature, scannedAt }
      log.warn("the scanner gave no verdict", { size: base.size })
    }
    const policy = await this.#settings.get("scanner.unavailablePolicy")
    return policy === "allow"
      ? { ...facts, status: "not_scanned", signature: null, scannedAt: null }
      : { ...facts, status: "waiting", signature: null, scannedAt: null }
  }

  /**
   * Stores content its scan allows (clean, not fully scanned, or not scanned) together with its row, inside the
   * caller's transaction: the hash's lock first, then the file (unless it is already on disk under a row), then the
   * row. The file is published and synced before the row is written, so a committed row always has its file. Refuses
   * every other status and content that does not match its scan, before touching the disk.
   */
  async storeIn(tx: Tx, bytes: Uint8Array, outcome: ScanOutcome, hooks?: WriteHooks) {
    if (!(STORED_STATUSES as readonly ScanStatus[]).includes(outcome.status))
      throw new Error(`content with status ${outcome.status} is never stored`)
    const status = outcome.status as StoredStatus
    if (bytes.byteLength !== outcome.size || sha256Of(bytes) !== outcome.sha256)
      throw new Error("the content does not match its scan")
    await lockStoredFile(tx, outcome.sha256)
    const [existing] = await tx.select().from(storedFile).where(eq(storedFile.sha256, outcome.sha256))
    if (!existing || !(await this.#store.has(outcome.sha256, outcome.size)))
      await this.#store.write(outcome.sha256, bytes, hooks)
    // A scanner's answer replaces an earlier one; "not scanned" never replaces a scanner's answer.
    if (existing && status === "not_scanned" && existing.scanStatus !== "not_scanned") return existing
    const row = {
      size: outcome.size,
      detectedType: outcome.detectedType,
      scanStatus: status,
      signature: outcome.signature,
      scannedAt: outcome.scannedAt,
    }
    const [stored] = await tx
      .insert(storedFile)
      .values({ sha256: outcome.sha256, ...row })
      .onConflictDoUpdate({ target: storedFile.sha256, set: row })
      .returning()
    if (!stored) throw new Error("the stored file's row was not written")
    return stored
  }

  /** storeIn in a transaction of its own. */
  async store(bytes: Uint8Array, outcome: ScanOutcome, hooks?: WriteHooks) {
    return this.#db.transaction((tx) => this.storeIn(tx, bytes, outcome, hooks))
  }

  /**
   * The daily sweep: removes stored files that no row references and writers' temporary files, once older than
   * `olderThanMs`. Each is removed only under its hash's lock, after checking again under that lock that no row
   * references a stored file, and that a temporary file is still there and still old, so a writer and the sweep never
   * interleave on one hash.
   */
  async sweep(olderThanMs = SWEEP_AGE_MS): Promise<{ removed: number; temporary: number }> {
    const cutoff = this.#now().getTime() - olderThanMs
    let removed = 0
    let temporary = 0
    for await (const entry of this.#store.entries()) {
      if (entry.modified.getTime() > cutoff) continue
      if (entry.temp) {
        // A live writer holds its hash's lock for as long as its temporary file exists, so under the lock a temporary
        // file that is still there and still old belongs to a writer that died.
        const gone = await this.#db.transaction(async (tx) => {
          await lockStoredFile(tx, entry.sha256)
          const modified = await this.#store.modified(entry.shard, entry.name)
          if (!modified || modified.getTime() > cutoff) return false
          await this.#store.remove(entry.shard, entry.name)
          return true
        })
        if (gone) temporary++
        continue
      }
      const referenced = async (db: Pick<Db, "select">) =>
        (await db.select({ sha256: storedFile.sha256 }).from(storedFile).where(eq(storedFile.sha256, entry.sha256)))
          .length > 0
      if (await referenced(this.#db)) continue
      const gone = await this.#db.transaction(async (tx) => {
        await lockStoredFile(tx, entry.sha256)
        if (await referenced(tx)) return false
        await this.#store.remove(entry.shard, entry.name)
        return true
      })
      if (gone) removed++
    }
    if (removed || temporary) log.info("swept unreferenced files", { removed, temporary })
    return { removed, temporary }
  }
}

/** Where a blocked file was found. Phase 2.3 fills these from its message and part. */
export interface BlockedPart {
  ticketId: string | null
  messageId: string | null
  partId: string | null
  fileName: string | null
}

/**
 * Writes the audit row of a blocked file (plan 2.2, P10) in the caller's transaction: the ticket, the message, the
 * part, the file name, and the signature or the blocked type, never the content. Only when the part's status becomes
 * blocked: a retry of a part that was already blocked writes nothing. Returns whether it wrote the row.
 */
export async function auditBlockedPart(
  tx: Pick<Db, "insert">,
  previous: ScanStatus | null,
  outcome: ScanOutcome,
  part: BlockedPart,
): Promise<boolean> {
  if (outcome.status !== "infected" && outcome.status !== "blocked_type") return false
  if (previous === "infected" || previous === "blocked_type") return false
  await writeAudit(tx, SYSTEM, {
    action: "file.blocked",
    entityType: "message_part",
    entityId: part.partId,
    details: {
      ticket: part.ticketId,
      message: part.messageId,
      part: part.partId,
      fileName: part.fileName,
      reason: outcome.status,
      ...(outcome.status === "infected" ? { signature: outcome.signature } : { type: outcome.blockedBy }),
      sha256: outcome.sha256,
    },
  })
  return true
}
