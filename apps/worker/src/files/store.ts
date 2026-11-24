import { randomBytes } from "node:crypto"
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { SHA256_HEX, SHARDS, shardOf, storedFilePath } from "@maane/server/files/paths"
import { sql } from "drizzle-orm"
import type { Tx } from "./types.ts"

export async function lockStoredFile(tx: Pick<Tx, "execute">, sha256: string): Promise<void> {
  if (!SHA256_HEX.test(sha256)) throw new Error("not a SHA-256 in hex")
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`stored-file:${sha256}`}, 0))`)
}

const TEMP_NAME = /^\.([0-9a-f]{64})\.[0-9a-f]{16}\.tmp$/

async function syncDir(path: string): Promise<void> {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class FileStore {
  constructor(readonly dir: string) {}

  path(sha256: string): string {
    return storedFilePath(this.dir, sha256)
  }

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

  async has(sha256: string, size: number): Promise<boolean> {
    const info = await stat(this.path(sha256)).catch(() => null)
    return info?.isFile() === true && info.size === size
  }

  async write(sha256: string, bytes: Uint8Array): Promise<void> {
    const shard = join(this.dir, shardOf(sha256))
    const temp = join(shard, `.${sha256}.${randomBytes(8).toString("hex")}.tmp`)
    try {
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
  }

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

  async modified(shard: string, name: string): Promise<Date | null> {
    const info = await stat(join(this.dir, shard, name)).catch(() => null)
    return info?.isFile() ? info.mtime : null
  }

  async remove(shard: string, name: string): Promise<void> {
    await rm(join(this.dir, shard, name), { force: true })
    await syncDir(join(this.dir, shard))
  }
}
