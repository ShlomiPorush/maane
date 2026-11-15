import { createECDH, randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { ENDPOINT_MAX, pushEndpointAllowed, subscriptionKeysValid } from "./push.ts"

describe("pushEndpointAllowed", () => {
  it("takes the browsers' push services over https", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc123",
      "https://FCM.googleapis.com/fcm/send/abc123",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
      "https://web.push.apple.com/QGuQyavXutnMH",
    ])
      expect(pushEndpointAllowed(endpoint), endpoint).toBe(true)
  })

  it("refuses everything else: other hosts, look-alikes, addresses, internal names, http, ports, credentials", () => {
    const password = ["user", randomBytes(4).toString("hex")].join(":")
    for (const endpoint of [
      "",
      "not a url",
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      `https://${password}@fcm.googleapis.com/fcm/send/abc`,
      "https://fcm.googleapis.com.example.com/fcm/send/abc",
      "https://evilfcm.googleapis.com/fcm/send/abc",
      "https://example.com/push",
      "https://notify.windows.com/w/",
      "https://evilnotify.windows.com/w/",
      "https://push.apple.com.example.com/",
      "https://localhost/push",
      "https://127.0.0.1/push",
      "https://192.0.2.10/push",
      "https://[2001:db8::1]/push",
      "https://maane-postgres/push",
      "file:///etc/passwd",
      `https://fcm.googleapis.com/${"a".repeat(ENDPOINT_MAX)}`,
      `https://fcm.googleapis.com/fcm/send/${String.fromCodePoint(0x5d0).repeat(1000)}`,
      "https://fcm.googleapis.com/fcm/send/a b",
    ])
      expect(pushEndpointAllowed(endpoint), endpoint).toBe(false)
  })
})

describe("subscriptionKeysValid", () => {
  it("takes a browser's P-256 key and 16-byte auth secret, base64url, and nothing else", () => {
    const curve = createECDH("prime256v1")
    curve.generateKeys()
    const p256dh = curve.getPublicKey().toString("base64url")
    const auth = randomBytes(16).toString("base64url")
    expect(subscriptionKeysValid(p256dh, auth)).toBe(true)
    expect(subscriptionKeysValid(`${p256dh}=`, `${auth}==`)).toBe(true)
    expect(subscriptionKeysValid(p256dh, randomBytes(15).toString("base64url"))).toBe(false)
    expect(subscriptionKeysValid(curve.getPublicKey("base64url", "compressed"), auth)).toBe(false)
    expect(subscriptionKeysValid("<p256dh>", auth)).toBe(false)
  })
})
