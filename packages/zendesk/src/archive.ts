import { createHash, randomBytes } from "node:crypto"
import { appendFile, link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, join, resolve, sep } from "node:path"

export const ARCHIVE_FORMAT = "maane-zendesk-archive"
export const ARCHIVE_VERSION = 1

/** archive.json: what the directory holds. Written once, when the archive is created. */
export interface ArchiveInfo {
  format: typeof ARCHIVE_FORMAT
  version: number
  /** The API origin the archive was made from. A later run must use the same one. */
  apiOrigin: string
  createdAt: string
}

/** Where an incremental export continues. */
export interface ExportPosition {
  /** The next page's sequence number in raw/incremental/<name>/. */
  seq: number
  /** Cursor-based exports: the cursor to continue from. */
  cursor?: string
  /** Time-based exports: the start time to continue from (Unix seconds). */
  startTime?: number
  /** True once the export reached the end of the stream at least once. */
  caughtUp: boolean
}

export interface TicketState {
  /** `updated_at` of the newest version of the ticket the export returned. */
  updatedAt: string
  status: string
  /** `updated_at` of the version whose comments and audits are saved, or null. */
  savedFor: string | null
  /**
   * The ticket was deleted in Zendesk: it answered 404, or the export listed it as deleted. The files its saved pages
   * list are in the manifest; nothing more is fetched for it.
   */
  gone?: boolean
  /** For a deleted ticket: the files its saved pages list, from every version, are in the manifest. */
  filesRecorded?: boolean
  /** The saved version has no side conversations because a run could not read them; a later run adds them. */
  sideConversationsMissing?: boolean
}

/** state.json: everything a run needs to continue where the previous one stopped. */
export interface ArchiveState {
  runs: number
  exports: Record<string, ExportPosition>
  tickets: Record<string, TicketState>
  /**
   * Changes up to this time are in the archive: Zendesk's own clock (its Date header) at the end of the ticket
   * export, less the minute the export leaves out. Null when Zendesk sent no Date header.
   */
  coveredUntil: string | null
}

/**
 * version.json in each saved ticket version: written last, once every list and file of that version was handled.
 * The check requires it for the newest version and the lists it names.
 */
export interface VersionMarker {
  updatedAt: string
  /** "saved": the side conversations list and each one's events are in this folder. */
  sideConversations: "saved" | "unavailable"
  sideConversationIds: string[]
  savedAt: string
}

export const VERSION_MARKER = "version.json"

export type FileStatus = "ok" | "failed"

/** One expected file: an attachment or inline image of a comment, or an attachment of a side conversation. */
export interface ManifestEntry {
  attachmentId: string
  ticketId: string
  /** The comment, or `side:<event id>` for a side conversation message. */
  commentId: string
  fileName: string
  contentType: string | null
  inline: boolean
  /** The size Zendesk reported. */
  size: number | null
  contentUrl: string | null
  status: FileStatus
  /** Set when status is ok: the content's SHA-256, stored at files/<first two>/<sha256>. */
  sha256?: string
  bytes?: number
  /** Set when status is failed: why. */
  error?: string
  attempts: number
  updatedAt: string
}

/** manifest.json: every expected file, tied to a verified download or an explicit failure. */
export interface Manifest {
  files: Record<string, ManifestEntry>
}

/** One line of raw-index.jsonl: a raw page as written, with its hash. A later line for the same path wins. */
export interface RawIndexEntry {
  path: string
  sha256: string
  bytes: number
}

export const RAW_INDEX = "raw-index.jsonl"

export const emptyState = (): ArchiveState => ({ runs: 0, exports: {}, tickets: {}, coveredUntil: null })

export class Archive {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  /** A path inside the archive. Refuses one that would leave it, whatever the parts hold. */
  path(...parts: string[]): string {
    const full = resolve(this.root, ...parts)
    if (full !== this.root && !full.startsWith(this.root + sep))
      throw new Error("a path outside the archive was refused")
    return full
  }

  filePath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("not a SHA-256")
    return this.path("files", sha256.slice(0, 2), sha256)
  }

  /**
   * Writes a file through a temporary name, flushed to disk, and a rename, so a crash never leaves half a file
   * under the final name.
   */
  async write(relativePath: string, content: string): Promise<void> {
    const target = this.path(relativePath)
    await mkdir(dirname(target), { recursive: true })
    const temporary = join(dirname(target), `.tmp-${randomBytes(6).toString("hex")}`)
    const handle = await open(temporary, "wx")
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
  }

  /**
   * Drops a last line of raw-index.jsonl that a crash cut short, so the next entry starts on a line of its own. Runs
   * under the lock, before anything is appended. Reads backwards from the end only as far as the last line break,
   * so a large index costs no more than its last line. A damaged line before the last stays for the check to report.
   */
  async repairRawIndex(): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(this.path(RAW_INDEX), "r+")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    try {
      const { size } = await handle.stat()
      const chunk = Buffer.alloc(64 * 1024)
      let end = size
      let keep = 0
      while (end > 0) {
        const start = Math.max(0, end - chunk.length)
        const { bytesRead } = await handle.read(chunk, 0, end - start, start)
        const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a)
        if (end === size && newline === bytesRead - 1) return // ends with a line break: nothing to repair
        if (newline >= 0) {
          keep = start + newline + 1
          break
        }
        end = start
      }
      await handle.truncate(keep)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /** Writes a raw API page and records its hash in raw-index.jsonl, which the check compares against. */
  async writeRaw(relativePath: string, text: string): Promise<void> {
    await this.write(relativePath, text)
    const entry: RawIndexEntry = {
      path: relativePath,
      sha256: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    }
    const handle = await open(this.path(RAW_INDEX), "a")
    try {
      await handle.appendFile(`${JSON.stringify(entry)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async readJson<T>(relativePath: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path(relativePath), "utf8")) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  async writeJson(relativePath: string, value: unknown): Promise<void> {
    await this.write(relativePath, `${JSON.stringify(value, null, 2)}\n`)
  }

  async info(): Promise<ArchiveInfo | undefined> {
    return this.readJson<ArchiveInfo>("archive.json")
  }

  async state(): Promise<ArchiveState> {
    return (await this.readJson<ArchiveState>("state.json")) ?? emptyState()
  }

  async saveState(state: ArchiveState): Promise<void> {
    await this.writeJson("state.json", state)
  }

  async manifest(): Promise<Manifest> {
    return (await this.readJson<Manifest>("manifest.json")) ?? { files: {} }
  }

  async saveManifest(manifest: Manifest): Promise<void> {
    await this.writeJson("manifest.json", manifest)
  }

  /**
   * Takes the archive for one run. The lock file is created complete in one step (written under a temporary name,
   * then hard-linked to `.lock`, which fails when it exists), so another run never reads half a lock. An existing
   * lock is never taken over, also when its run looks finished: two runs that both did so could each remove the
   * other's. The message names the file to remove once no run is active.
   */
  async lock(): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true })
    const lockPath = this.path(".lock")
    const token = randomBytes(12).toString("hex")
    const content = `${JSON.stringify({ pid: process.pid, host: hostname(), token, since: new Date().toISOString() })}\n`
    const temporary = this.path(`.lock-${token}`)
    await appendFile(temporary, content, { flag: "wx" })
    try {
      await link(temporary, lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const held = await readFile(lockPath, "utf8").catch(() => "")
      const pid = /"pid":(\d+)/.exec(held)?.[1]
      throw new Error(
        `another run holds this archive${pid ? ` (process ${pid})` : ""}. If no run is active, remove ${lockPath} and run again.`,
      )
    } finally {
      await rm(temporary, { force: true })
    }
    return async () => {
      const held = await readFile(lockPath, "utf8").catch(() => "")
      if (held.includes(token)) await rm(lockPath, { force: true })
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await stat(this.path(relativePath))
      return true
    } catch {
      return false
    }
  }
}

/** A timestamp that is safe in a file name on every system: 2026-11-11T20-01-00Z. */
export function stamp(iso: string): string {
  return iso.replace(/:/g, "-").replace(/[^0-9A-Za-z.-]/g, "_")
}

/** A page sequence number as it appears in file names: 000001. */
export function seqName(seq: number): string {
  return String(seq).padStart(6, "0")
}
