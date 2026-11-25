import { serve } from "@hono/node-server"
import { type Auth, createAuth } from "./auth/auth.ts"
import { SetupWindow } from "./auth/setup-window.ts"
import { loadConfig } from "./config.ts"
import { migrateDatabase, openDatabase } from "./db/client.ts"
import { createApp } from "./http/app.ts"
import { openJobQueue } from "./jobs/queue.ts"
import { errorFacts, log } from "./log.ts"
import { createSettingsCipher } from "./settings/crypto.ts"
import { Settings } from "./settings/service.ts"

async function main(): Promise<void> {
  const config = loadConfig()
  const setup = new SetupWindow()
  const database = openDatabase(config.databaseUrl)
  const auditDatabase = openDatabase(config.databaseUrl, 2)
  await migrateDatabase(database.db, config.migrationsDir)
  const settings = new Settings(database.db, createSettingsCipher(config.settingsKeys), config.overrides)
  const jobs = await openJobQueue(config.databaseUrl)

  const build = async () =>
    createAuth({
      db: database.db,
      auditDb: auditDatabase.db,
      secrets: config.authSecrets,
      publicUrl: config.publicUrl,
      setup,
      sessionDays: await settings.get("security.sessionDays"),
    })
  let auth: Auth = await build()

  const app = createApp({
    db: database.db,
    auth: () => auth,
    settings,
    setup,
    publicUrl: config.publicUrl,
    webDir: config.webDir,
    filesDir: config.filesDir,
    version: config.version,
    onSettingsChanged: async () => {
      auth = await build()
    },
    jobs,
    trustedProxies: config.trustedProxies,
    geoipDir: config.geoipDir,
    vapidPublicKey: config.vapid.publicKey,
    archiveDir: config.archiveDir,
  })

  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" })
  log.info("server started", { port: config.port, version: config.version })

  const stop = (signal: string) => {
    log.info("server stopping", { signal })
    server.close(() => {
      void Promise.all([jobs.stop(), database.close(), auditDatabase.close()]).then(() => process.exit(0))
    })
  }
  process.once("SIGTERM", () => stop("SIGTERM"))
  process.once("SIGINT", () => stop("SIGINT"))
}

main().catch((error) => {
  log.error("server failed to start", {
    ...errorFacts(error),
    reason: error instanceof Error && error.name === "ConfigError" ? error.message : null,
  })
  process.exit(1)
})
