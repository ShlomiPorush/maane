import { createHmac } from "node:crypto"

// RFC 6238 TOTP (SHA-1, 6 digits, 30-second steps), as authenticator apps compute it. Written here, not taken from
// Better Auth, so the tests check its codes against an independent implementation.

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = ""
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(char)
    if (value < 0) throw new Error("invalid base32 character")
    bits += value.toString(2).padStart(5, "0")
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

export function totp(secret: string, time = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)))
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest()
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return code.toString().padStart(6, "0")
}

/** The base32 secret of an otpauth:// URI. */
export const secretOf = (uri: string) => new URL(uri).searchParams.get("secret") ?? ""
