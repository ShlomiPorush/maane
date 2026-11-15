// The part of http_ece (the encrypted content encoding web-push uses) the notification tests read a push with.
declare module "http_ece" {
  import type { ECDH } from "node:crypto"
  export function decrypt(
    buffer: Buffer,
    params: { version: "aes128gcm"; privateKey: ECDH; authSecret: Buffer | string },
  ): Buffer
}
