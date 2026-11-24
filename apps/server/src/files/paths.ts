import { join } from "node:path"

export const SHA256_HEX = /^[0-9a-f]{64}$/

export const SHARDS: readonly string[] = Array.from({ length: 256 }, (_, n) => n.toString(16).padStart(2, "0"))

export function shardOf(sha256: string): string {
  if (!SHA256_HEX.test(sha256)) throw new Error("not a SHA-256 in hex")
  return sha256.slice(0, 2)
}

export function storedFilePath(filesDir: string, sha256: string): string {
  return join(filesDir, shardOf(sha256), sha256)
}
