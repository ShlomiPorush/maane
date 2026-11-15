// A stand-in push service for the notification tests (plan 4.5): HTTPS on 127.0.0.1 with a certificate made for it,
// trusted only through the https.Agent it hands to web-push's documented `agent` option (never process-wide). It
// records every request (path, headers, body) and answers 201, or what a test sets for a path: 404 and 410 as a
// revoked subscription, a redirect with a Location. A test may also give work the next request waits for. Nothing
// reaches a real push service.

import { createECDH, randomBytes } from "node:crypto"
import { Agent, createServer } from "node:https"
import type { AddressInfo } from "node:net"
import { standInCertificate } from "./smtp.ts"

export type PushRequest = { path: string; headers: Record<string, string | string[] | undefined>; body: Buffer }

export interface StandInPush {
  origin: string
  /** A new endpoint path on the stand-in. */
  endpoint(): string
  received: PushRequest[]
  /** What the stand-in answers on one endpoint from now on. */
  answer(endpoint: string, status: number, headers?: Record<string, string>): void
  /** Work the next request waits for before it is answered, once: a change made while a push is pending. */
  during(work: (() => Promise<void>) | null): void
  agent: Agent
  close(): Promise<void>
}

export async function startStandInPush(): Promise<StandInPush> {
  const pems = await standInCertificate(["localhost"])
  const received: PushRequest[] = []
  const answers = new Map<string, { status: number; headers: Record<string, string> }>()
  let pending: (() => Promise<void>) | null = null
  const server = createServer({ key: pems.private, cert: pems.cert }, (request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", async () => {
      const path = request.url ?? ""
      received.push({ path, headers: request.headers, body: Buffer.concat(chunks) })
      const work = pending
      pending = null
      try {
        await work?.()
      } finally {
        const answer = answers.get(path) ?? { status: 201, headers: {} }
        response.writeHead(answer.status, answer.headers).end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  const agent = new Agent({ ca: pems.cert, keepAlive: false })
  return {
    origin,
    endpoint: () => `${origin}/push/${randomBytes(12).toString("hex")}`,
    received,
    answer(endpoint, status, headers = {}) {
      answers.set(new URL(endpoint).pathname, { status, headers })
    },
    during(work) {
      pending = work
    },
    agent,
    close: () =>
      new Promise<void>((resolve) => {
        agent.destroy()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** A browser's side of a subscription: its P-256 key pair and auth secret, new for each call. */
export function browserKeys() {
  const curve = createECDH("prime256v1")
  curve.generateKeys()
  const auth = randomBytes(16)
  return {
    curve,
    auth,
    keys: { p256dh: curve.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
  }
}
