import { createServer } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { refusedAddress, type StandInClamd, type StandInOptions, startStandInClamd } from "../testing/clamd.ts"
import { ClamdError, MAX_REPLY_BYTES, ping, scanStream, version } from "./clamd.ts"
import { CLEAN_SAMPLE, eicar } from "./samples.ts"
import { clamdScanner } from "./scanner.ts"

// Maane's clamd client against the stand-in: the answers clamd gives, and every way a peer can fail to give one. Each
// failure must reject with its code within the operation's deadline and leave no socket behind.

const opened: StandInClamd[] = []
const standIn = async (options: StandInOptions = {}) => {
  const clamd = await startStandInClamd(options)
  opened.push(clamd)
  const [host, port] = clamd.address.split(":")
  return { clamd, target: { host: host as string, port: Number(port) } }
}
afterEach(async () => {
  for (const clamd of opened.splice(0)) await clamd.close()
})

/** The code an operation rejects with, and how long it took. */
async function failure(operation: Promise<unknown>): Promise<{ code: string; ms: number }> {
  const started = Date.now()
  try {
    await operation
  } catch (error) {
    return { code: error instanceof ClamdError ? error.code : "not a ClamdError", ms: Date.now() - started }
  }
  return { code: "resolved", ms: Date.now() - started }
}

describe("the clamd protocol", () => {
  it("scans through zINSTREAM in length-prefixed chunks and reads OK and FOUND", async () => {
    const { clamd, target } = await standIn()
    expect(await scanStream(target, CLEAN_SAMPLE, { deadlineMs: 5_000 })).toEqual({ found: null })
    expect(await scanStream(target, eicar(), { deadlineMs: 5_000 })).toEqual({ found: "Eicar-Test-Signature" })
    const large = Buffer.alloc(300_000, 0x62)
    expect(await scanStream(target, large, { deadlineMs: 5_000 })).toEqual({ found: null })
    expect(clamd.scanned.at(-1)?.equals(large)).toBe(true)
    expect(await scanStream(target, new Uint8Array(0), { deadlineMs: 5_000 })).toEqual({ found: null })
    expect(clamd.scanned.at(-1)?.length).toBe(0)
  })

  it("answers PING and VERSION", async () => {
    const { target } = await standIn()
    await expect(ping(target, { deadlineMs: 5_000 })).resolves.toBeUndefined()
    expect(await version(target, { deadlineMs: 5_000 })).toBe("ClamAV 1.5.4/0/stand-in")
  })

  it("rejects clamd's StreamMaxLength refusal as a size limit, never as clean", async () => {
    const { target } = await standIn({ streamMaxLength: 100_000 })
    expect(await failure(scanStream(target, Buffer.alloc(2_000_000, 0x63), { deadlineMs: 5_000 }))).toMatchObject({
      code: "size_limit",
    })
    expect(await failure(scanStream(target, Buffer.alloc(200_000, 0x63), { deadlineMs: 5_000 }))).toMatchObject({
      code: "size_limit",
    })
    const scanner = await standIn({ streamMaxLength: 100_000 })
    expect(await clamdScanner.scan(scanner.clamd.address, Buffer.alloc(200_000, 0x63), 5_000)).toEqual({
      kind: "error",
    })
  })

  it("gives up at the deadline on a peer that reads everything and never answers or closes", async () => {
    const { target } = await standIn({ peer: "silent" })
    const scan = await failure(scanStream(target, CLEAN_SAMPLE, { deadlineMs: 500 }))
    expect(scan.code).toBe("deadline")
    expect(scan.ms).toBeLessThan(2_000)
    expect((await failure(ping(target, { deadlineMs: 300 }))).code).toBe("deadline")
    expect((await failure(version(target, { deadlineMs: 300 }))).code).toBe("deadline")
  })

  it("rejects at once when the peer ends its side without an answer", async () => {
    const { target } = await standIn({ peer: "halfClose" })
    const scan = await failure(scanStream(target, CLEAN_SAMPLE, { deadlineMs: 5_000 }))
    expect(scan.code).toBe("closed")
    expect(scan.ms).toBeLessThan(2_000)
  })

  it("gives up at the deadline on a peer that accepts and never reads", async () => {
    const { target } = await standIn({ peer: "noRead" })
    // Far more than the socket buffers hold, so the client waits to write until the deadline frees it.
    const scan = await failure(scanStream(target, Buffer.alloc(32 * 1024 * 1024, 0x64), { deadlineMs: 800 }))
    expect(scan.code).toBe("deadline")
    expect(scan.ms).toBeLessThan(3_000)
  })

  it("gives up at the deadline on a peer that trickles a reply that never ends", async () => {
    const { target } = await standIn({ peer: "trickle" })
    const scan = await failure(scanStream(target, CLEAN_SAMPLE, { deadlineMs: 700 }))
    expect(scan.code).toBe("deadline")
    expect(scan.ms).toBeLessThan(2_000)
  })

  it("refuses a reply longer than clamd ever gives", async () => {
    const { target } = await standIn({ peer: "flood" })
    expect(MAX_REPLY_BYTES).toBeLessThan(16 * 1024)
    expect((await failure(scanStream(target, CLEAN_SAMPLE, { deadlineMs: 5_000 }))).code).toBe("reply_too_long")
  })

  it("refuses a padded reply over the limit even when its terminator arrives, in one write or across the limit", async () => {
    for (const peer of ["padded", "paddedSplit"] as const) {
      const { target } = await standIn({ peer })
      expect((await failure(scanStream(target, CLEAN_SAMPLE, { deadlineMs: 5_000 }))).code).toBe("reply_too_long")
    }
  })

  it("reports a refused connection, and a connection that never completes, by their own codes", async () => {
    const refused = await refusedAddress()
    const [host, port] = refused.split(":")
    const target = { host: host as string, port: Number(port) }
    expect((await failure(ping(target, { deadlineMs: 5_000 }))).code).toBe("refused")
    // A listener whose backlog is full leaves new connections waiting; the documentation range never answers either,
    // but needs a network. A connect timeout shorter than the deadline names the step.
    const blackhole = { host: "192.0.2.1", port: 3310 }
    const stuck = await failure(ping(blackhole, { deadlineMs: 2_000, connectTimeoutMs: 300 }))
    expect(["connect_timeout", "connection"]).toContain(stuck.code)
    expect(stuck.ms).toBeLessThan(2_000)
  })

  it("closes every socket it opened, also when it gives up", async () => {
    const connections = new Set<import("node:net").Socket>()
    // Not half-open: the server side closes as soon as the client closes its own, so a count of 0 means none is left.
    const server = createServer((socket) => {
      connections.add(socket)
      socket.on("close", () => connections.delete(socket))
      socket.on("data", () => {})
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port
    for (let n = 0; n < 5; n++)
      await failure(scanStream({ host: "127.0.0.1", port }, CLEAN_SAMPLE, { deadlineMs: 100 }))
    await expect.poll(() => connections.size, { timeout: 2_000 }).toBe(0)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})
