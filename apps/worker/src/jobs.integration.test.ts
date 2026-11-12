import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SYSTEM } from "@maane/server/audit"
import { scannerCheck } from "@maane/server/db/schema"
import { FILES_SWEEP, openJobQueue, SCANNER_SELF_TEST } from "@maane/server/jobs/queue"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { createTestDatabase, testKey } from "@maane/server/testing/db"
import { PgBoss } from "pg-boss"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { clamdScanner } from "./files/scanner.ts"
import { FileService } from "./files/service.ts"
import { FileStore } from "./files/store.ts"
import { registerJobs } from "./jobs.ts"
import { type StandInClamd, startStandInClamd } from "./testing/clamd.ts"

let database: Awaited<ReturnType<typeof createTestDatabase>>
let boss: PgBoss
let dir: string
let clamd: StandInClamd

beforeAll(async () => {
  database = await createTestDatabase()
  dir = await mkdtemp(join(tmpdir(), "maane-worker-"))
  clamd = await startStandInClamd()
  boss = new PgBoss({ connectionString: database.url, schema: "pgboss" })
  await boss.start()
})

afterAll(async () => {
  await boss.stop({ graceful: false })
  await clamd.close()
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

  it("runs the scanner self-test at start and for a test the server queues, with its result as the output", async () => {
    const settings = new Settings(database.db, createSettingsCipher([{ version: 1, value: testKey() }]), {})
    await settings.update({ "scanner.address": clamd.address }, SYSTEM)
    const store = new FileStore(join(dir, "files"))
    await store.prepare()
    const files = new FileService({ db: database.db, settings, scanner: clamdScanner, store })
    await registerJobs(boss, { heartbeatFile: join(dir, "heartbeat"), files })
    const names = (await boss.getSchedules()).map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining([SCANNER_SELF_TEST, FILES_SWEEP]))
    // The self-test queued at start writes the scanner's status.
    await expect
      .poll(async () => (await database.db.select().from(scannerCheck))[0]?.ok, { timeout: 20_000 })
      .toBe(true)

    // The server's side: queue a connection test and read its state until the worker finished it.
    const queue = await openJobQueue(database.url)
    try {
      const id = await queue.send(SCANNER_SELF_TEST)
      await expect
        .poll(async () => (await queue.job(SCANNER_SELF_TEST, id))?.state, { timeout: 20_000 })
        .toBe("completed")
      expect((await queue.job(SCANNER_SELF_TEST, id))?.output).toMatchObject({
        address: clamd.address,
        ok: true,
        failedCheck: null,
        version: "ClamAV 1.5.4/0/stand-in",
      })
    } finally {
      await queue.stop()
    }
  })

  it("finishes the self-test job when the scanner stops answering, so a stuck scanner cannot hold the queue", async () => {
    const stuck = await startStandInClamd({ peer: "silent" })
    try {
      const settings = new Settings(database.db, createSettingsCipher([{ version: 1, value: testKey() }]), {})
      await settings.update({ "scanner.address": stuck.address }, SYSTEM)
      const queue = await openJobQueue(database.url)
      try {
        const started = Date.now()
        const id = await queue.send(SCANNER_SELF_TEST)
        await expect
          .poll(async () => (await queue.job(SCANNER_SELF_TEST, id))?.state, { timeout: 25_000 })
          .toBe("completed")
        // PING waits at most its 10-second deadline, then the job ends with the check that failed.
        expect(Date.now() - started).toBeLessThan(25_000)
        expect((await queue.job(SCANNER_SELF_TEST, id))?.output).toMatchObject({
          address: stuck.address,
          ok: false,
          failedCheck: "connection",
        })
        // The queue goes on: the next test is picked up and finished too.
        const next = await queue.send(SCANNER_SELF_TEST)
        await expect
          .poll(async () => (await queue.job(SCANNER_SELF_TEST, next))?.state, { timeout: 25_000 })
          .toBe("completed")
      } finally {
        await queue.stop()
      }
    } finally {
      await stuck.close()
    }
  }, 60_000)
})
