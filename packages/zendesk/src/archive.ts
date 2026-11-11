import { randomBytes } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

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
  /** The ticket answered 404 when its comments were read: deleted after the export listed it. */
  gone?: boolean
}

/** state.json: everything a run needs to continue where the previous one stopped. */
export interface ArchiveState {
  runs: number
  exports: Record<string, ExportPosition>
  tickets: Record<string, TicketState>
  /** Changes up to this time are in the archive (the export leaves out the last minute). */
  coveredUntil: string | null
}

export type FileStatus = "ok" | "failed"

/** One expected file: an attachment or inline image of a comment. */
export interface ManifestEntry {
  attachmentId: string
  ticketId: string
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

export const emptyState = (): ArchiveState => ({ runs: 0, exports: {}, tickets: {}, coveredUntil: null })

export class Archive {
  constructor(readonly root: string) {}

  path(...parts: string[]): string {
    return join(this.root, ...parts)
  }

  filePath(sha256: string): string {
    return this.path("files", sha256.slice(0, 2), sha256)
  }

  /** Writes a file through a temporary name and a rename, so a crash never leaves half a file. */
  async write(relative: string, content: string): Promise<void> {
    const target = this.path(relative)
    await mkdir(dirname(target), { recursive: true })
    const temporary = join(dirname(target), `.tmp-${randomBytes(6).toString("hex")}`)
    await writeFile(temporary, content, { flag: "wx" })
    await rename(temporary, target)
  }

  async readJson<T>(relative: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path(relative), "utf8")) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  async writeJson(relative: string, value: unknown): Promise<void> {
    await this.write(relative, `${JSON.stringify(value, null, 2)}\n`)
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
   * Takes the archive for one run. A lock left by a process that no longer runs is taken over;
   * a lock of a running process refuses the run.
   */
  async lock(): Promise<() => Promise<void>> {
    const lockPath = this.path(".lock")
    await mkdir(this.root, { recursive: true })
    for (let tries = 0; tries < 2; tries++) {
      try {
        const handle = await open(lockPath, "wx")
        await handle.writeFile(String(process.pid))
        await handle.close()
        return () => rm(lockPath, { force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const pid = Number((await readFile(lockPath, "utf8").catch(() => "")).trim())
        if (pid > 0 && pid !== process.pid && isRunning(pid)) {
          throw new Error(`another run (process ${pid}) is using this archive`)
        }
        await rm(lockPath, { force: true })
      }
    }
    throw new Error("could not lock the archive")
  }

  async exists(relative: string): Promise<boolean> {
    try {
      await stat(this.path(relative))
      return true
    } catch {
      return false
    }
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
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
