import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { serverHealthy, stopDraining } from "./health.ts"

let server: Server
let port: number
let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "maane-health-"))
  server = createServer((request, response) => {
    response.statusCode = request.url === "/healthz/ready" ? 200 : 404
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

describe("the server's health check", () => {
  it("passes while the server answers ready", async () => {
    expect(await serverHealthy(port, join(dir, "drain"))).toBe(true)
  })

  it("fails while the drain file exists, though the server still answers, and passes once it is removed", async () => {
    const drain = join(dir, "drain")
    await writeFile(drain, "")
    expect(await serverHealthy(port, drain)).toBe(false)
    await stopDraining(drain)
    expect(await serverHealthy(port, drain)).toBe(true)
  })
})
