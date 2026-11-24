declare module "http_ece" {
  import type { ECDH } from "node:crypto"
  export function decrypt(
    buffer: Buffer,
    params: { version: "aes128gcm"; privateKey: ECDH; authSecret: Buffer | string },
  ): Buffer
}
