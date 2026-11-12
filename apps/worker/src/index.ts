import { loadConfig } from "@maane/server/config"
import { errorFacts, log } from "@maane/server/log"
import { PgBoss } from "pg-boss"
import { registerJobs } from "./jobs.ts"

// The worker: the PostgreSQL job queue (pg-boss). It refuses to start on the same unsafe configuration as the
// server, so a stack never runs half configured.

async function main(): Promise<void> {
  const config = loadConfig()
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: "pgboss" })
  boss.on("error", (error) => log.error("the job queue reported an error", errorFacts(error)))
  await boss.start()
  await registerJobs(boss)
  log.info("worker started", { version: config.version })

  const stop = async (signal: string) => {
    log.info("worker stopping", { signal })
    await boss.stop({ graceful: true, timeout: 20_000 })
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
