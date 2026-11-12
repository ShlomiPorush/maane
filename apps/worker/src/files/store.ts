import { randomBytes } from "node:crypto"
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { SHA256_HEX, SHARDS, shardOf, storedFilePath } from "@maane/server/files/paths"
import { sql } from "drizzle-orm"
import type { Tx } from "./types.ts"

// The content-addressed store on disk (plan 2.2, P14, P20): <dir>/<first two hex>/<sha256>. Only the worker writes
// it, always inside the transaction that inserts the file's row, after it took the transaction-scoped advisory lock on
// the hash (lockStoredFile). Node's fs: a file is written under a temporary name in its shard, synced, and renamed into
// place, then the shard directory is synced, all before the row is inserted and the transaction commits. No directory
// is created at write time; prepare() creates them at worker start.

/** Holds, until the transaction ends, the lock every writer and the sweep take on one hash before they touch it. */
export async function lockStoredFile(tx: Pick<Tx, "execute">, sha256: string): Promise<void> {
  if (!SHA256_HEX.test(sha256)) throw new Error("not a SHA-256 in hex")
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`stored-file:${sha256}`}, 0))`)
}

/** A writer's temporary name: a dot, the hash, a random part, and `.tmp`. */
const TEMP_NAME = /^\.([0-9a-f]{64})\.[0-9a-f]{16}\.tmp$/

/** fsync of a directory, so the names created or removed in it survive a host crash. */
async function syncDir(path: string): Promise<void> {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Test seams: a step that runs right after the file is published and synced, before the row is written. */
export interface WriteHooks {
  afterPublish?: () => Promise<void>
}

export class FileStore {
  constructor(readonly dir: string) {}

  path(sha256: string): string {
    return storedFilePath(this.dir, sha256)
  }

  /**
   * Run at worker start, before any job: creates the store and its 256 shard directories when missing, then syncs
   * every shard, the store, and its parent, whether they were new or not. A failure stops the worker.
   */
  async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o750 })
    for (const shard of SHARDS) {
      await mkdir(join(this.dir, shard), { mode: 0o750 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
    }
    for (const shard of SHARDS) await syncDir(join(this.dir, shard))
    await syncDir(this.dir)
    await syncDir(dirname(this.dir))
  }

  /** Whether the file of this hash is on disk with the expected size. */
  async has(sha256: string, size: number): Promise<boolean> {
    const info = await stat(this.path(sha256)).catch(() => null)
    return info?.isFile() === true && info.size === size
  }

  /**
   * Writes the content under its hash. The caller holds the hash's lock in the transaction that will insert the row,
   * and inserts it only after this resolves: write a temporary file in the shard, sync it, rename it into place, and
   * sync the shard. A failure before the rename leaves no file; one after it leaves a file no row references, which
   * the sweep removes.
   */
  async write(sha256: string, bytes: Uint8Array, hooks: WriteHooks = {}): Promise<void> {
    const shard = join(this.dir, shardOf(sha256))
    const temp = join(shard, `.${sha256}.${randomBytes(8).toString("hex")}.tmp`)
    try {
      // "wx": never an existing file, and no directory is created here.
      const handle = await open(temp, "wx", 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, this.path(sha256))
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
    await syncDir(shard)
    await hooks.afterPublish?.()
  }

  /** The names in each shard: stored files and writers' temporary files, with their modification times. */
  async *entries(): AsyncGenerator<{ shard: string; name: string; sha256: string; temp: boolean; modified: Date }> {
    for (const shard of SHARDS) {
      const names = await readdir(join(this.dir, shard)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [] as string[]
        throw error
      })
      for (const name of names) {
        const temp = TEMP_NAME.exec(name)
        const sha256 = temp?.[1] ?? (SHA256_HEX.test(name) ? name : null)
        if (!sha256) continue
        const info = await stat(join(this.dir, shard, name)).catch(() => null)
        if (!info?.isFile()) continue
        yield { shard, name, sha256, temp: temp !== null, modified: info.mtime }
      }
    }
  }

  /** Removes one name from a shard and syncs the shard. */
  async remove(shard: string, name: string): Promise<void> {
    await rm(join(this.dir, shard, name), { force: true })
    await syncDir(join(this.dir, shard))
  }
}
