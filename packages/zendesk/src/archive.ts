import { createHash, randomBytes } from "node:crypto"
import { appendFile, link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, join, resolve, sep } from "node:path"

export const ARCHIVE_FORMAT = "maane-zendesk-archive"
export const ARCHIVE_VERSION = 1

export interface ArchiveInfo {
  format: typeof ARCHIVE_FORMAT
  version: number
  apiOrigin: string
  createdAt: string
}

export interface ExportPosition {
  seq: number
  cursor?: string
  startTime?: number
  caughtUp: boolean
}

export interface TicketState {
  updatedAt: string
  status: string
  savedFor: string | null
  gone?: boolean
  filesRecorded?: boolean
  sideConversationsMissing?: boolean
}

export interface ArchiveState {
  runs: number
  exports: Record<string, ExportPosition>
  tickets: Record<string, TicketState>
  coveredUntil: string | null
}

export interface VersionMarker {
  updatedAt: string
  sideConversations: "saved" | "unavailable"
  sideConversationIds: string[]
  savedAt: string
}

export const VERSION_MARKER = "version.json"

export type FileStatus = "ok" | "failed"

export interface ManifestEntry {
  attachmentId: string
  ticketId: string
  commentId: string
  fileName: string
  contentType: string | null
  inline: boolean
  size: number | null
  contentUrl: string | null
  status: FileStatus
  sha256?: string
  bytes?: number
  error?: string
  attempts: number
  updatedAt: string
}

export interface Manifest {
  files: Record<string, ManifestEntry>
}

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
        if (end === size && newline === bytesRead - 1) return
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

export function stamp(iso: string): string {
  return iso.replace(/:/g, "-").replace(/[^0-9A-Za-z.-]/g, "_")
}

export function seqName(seq: number): string {
  return String(seq).padStart(6, "0")
}
