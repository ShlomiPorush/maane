import { join } from "node:path"

// The layout of the content-addressed store (plan 2.2): <files dir>/<first two hex>/<sha256>. The worker writes it;
// from phase 2.4 the server reads it, always through an attachment the user may see, never by a hash from a request.

/** A SHA-256 as lower-case hex: the only name a stored file has. */
export const SHA256_HEX = /^[0-9a-f]{64}$/

/** The 256 shard directories, `00` to `ff`. The worker creates them at start; nothing creates one at write time. */
export const SHARDS: readonly string[] = Array.from({ length: 256 }, (_, n) => n.toString(16).padStart(2, "0"))

export function shardOf(sha256: string): string {
  if (!SHA256_HEX.test(sha256)) throw new Error("not a SHA-256 in hex")
  return sha256.slice(0, 2)
}

/** Where the file with this hash lives. */
export function storedFilePath(filesDir: string, sha256: string): string {
  return join(filesDir, shardOf(sha256), sha256)
}
