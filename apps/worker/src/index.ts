import { loadConfig } from "@maane/server/config"
import { openDatabase } from "@maane/server/db/client"
import { errorFacts, log } from "@maane/server/log"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { PgBoss } from "pg-boss"
import { clamdScanner } from "./files/scanner.ts"
import { FileService } from "./files/service.ts"
import { FileStore } from "./files/store.ts"
import { registerJobs } from "./jobs.ts"

// The worker: the PostgreSQL job queue (pg-boss). It refuses to start on the same unsafe configuration as the
// server, so a stack never runs half configured.

async function main(): Promise<void> {
  const config = loadConfig()
  // The store and its shard directories exist and are synced before any job runs (plan 2.2, P20).
  const store = new FileStore(config.filesDir)
  await store.prepare()
  const database = openDatabase(config.databaseUrl, 5)
  const settings = new Settings(database.db, createSettingsCipher(config.settingsKeys), config.overrides)
  const files = new FileService({ db: database.db, settings, scanner: clamdScanner, store })

  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: "pgboss" })
  boss.on("error", (error) => log.error("the job queue reported an error", errorFacts(error)))
  await boss.start()
  await registerJobs(boss, { files })
  log.info("worker started", { version: config.version })

  const stop = async (signal: string) => {
    log.info("worker stopping", { signal })
    await boss.stop({ graceful: true, timeout: 20_000 })
    await database.close()
    process.exit(0)
  }
  process.once("SIGTERM", () => void stop("SIGTERM"))
  process.once("SIGINT", () => void stop("SIGINT"))
}

main().catch((error) => {
  log.error("worker failed to start", {
    ...errorFacts(error),
    reason: error instanceof Error && error.name === "ConfigError" ? error.message : null,
  })
  process.exit(1)
})
