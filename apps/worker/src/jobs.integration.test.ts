import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestDatabase } from "@maane/server/testing/db"
import { PgBoss } from "pg-boss"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { registerJobs } from "./jobs.ts"

let database: Awaited<ReturnType<typeof createTestDatabase>>
let boss: PgBoss
let dir: string

beforeAll(async () => {
  database = await createTestDatabase()
  dir = await mkdtemp(join(tmpdir(), "maane-worker-"))
  boss = new PgBoss({ connectionString: database.url, schema: "pgboss" })
  await boss.start()
})

afterAll(async () => {
  await boss.stop({ graceful: false })
  await database.drop()
  await rm(dir, { recursive: true, force: true })
})

describe("worker jobs", () => {
  it("schedules the heartbeat and writes the heartbeat file when it runs", async () => {
    const file = join(dir, "heartbeat")
    await registerJobs(boss, { heartbeatFile: file, now: () => 1234 })
    expect((await boss.getSchedules()).map((s) => s.name)).toContain("heartbeat")
    await boss.send("heartbeat")
    await expect.poll(() => readFile(file, "utf8").catch(() => ""), { timeout: 15_000 }).toBe("1234")
  })
})
