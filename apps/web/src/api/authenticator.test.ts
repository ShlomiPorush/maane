// The authenticator app names the account after the username; the secret and every other part of Better Auth's
// link stay as they were. A new base32 secret per run: no working value in the repository.

import { userEmail } from "@maane/shared"
import { describe, expect, it } from "vitest"
import { authenticatorUri, totpSecret } from "./authenticator.ts"

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const newSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => BASE32[b % 32]).join("")

describe("authenticatorUri", () => {
  it("replaces the synthetic e-mail with the username and keeps the rest", () => {
    const secret = newSecret()
    const query = `?secret=${secret}&issuer=Maane&digits=6&period=30`
    const uri = `otpauth://totp/Maane:${encodeURIComponent(userEmail("first.admin"))}${query}`
    expect(authenticatorUri(uri)).toBe(`otpauth://totp/Maane:first.admin${query}`)
    expect(totpSecret(authenticatorUri(uri))).toBe(secret)
  })

  it("leaves any other link as it is", () => {
    const query = `?secret=${newSecret()}&issuer=Maane`
    for (const uri of [
      `otpauth://totp/Maane:someone%40example.com${query}`,
      `otpauth://totp/Maane${query}`,
      `otpauth://hotp/Maane:${encodeURIComponent(userEmail("x.y"))}${query}`,
      "not a link",
    ])
      expect(authenticatorUri(uri)).toBe(uri)
  })
})
