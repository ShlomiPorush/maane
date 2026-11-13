import { loadConfig } from "@maane/server/config"
import { openDatabase } from "@maane/server/db/client"
import { errorFacts, log } from "@maane/server/log"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import type { SettingKey } from "@maane/shared"
import { PgBoss } from "pg-boss"
import { clamdScanner } from "./files/scanner.ts"
import { FileService } from "./files/service.ts"
import { FileStore } from "./files/store.ts"
import { GraphGateway } from "./intake/graph.ts"
import { reconcileIntakeSource } from "./intake/jobs.ts"
import { IntakeProcessor } from "./intake/process.ts"
import { WaitingFiles } from "./intake/retry.ts"
import { IntakeSync } from "./intake/sync.ts"
import { registerJobs } from "./jobs.ts"
import { ReplySender } from "./send/sender.ts"
import type { SmtpTimeouts } from "./send/smtp.ts"

// The worker: the PostgreSQL job queue (pg-boss). It refuses to start on the same unsafe configuration as the
// server, so a stack never runs half configured. index.ts starts it as configured; the stack check starts it the same
// way with stand-ins' settings given to its own process only (apps/worker/src/testing/stack-worker.ts).

/** How long one statement of a send may take, a lock wait included. */
export const SEND_STATEMENT_TIMEOUT_MS = 30_000

export interface WorkerOptions {
  /** Settings this process alone uses, on top of the environment's (the stack check's stand-ins). */
  overrides?: Partial<Record<SettingKey, string>>
  timeouts?: SmtpTimeouts
}

export async function startWorker(options: WorkerOptions = {}): Promise<{ stop(): Promise<void> }> {
  const config = loadConfig()
  // The store and its shard directories exist and are synced before any job runs (plan 2.2, P20).
  const store = new FileStore(config.filesDir)
  await store.prepare()
  const database = openDatabase(config.databaseUrl, 5)
  const settings = new Settings(database.db, createSettingsCipher(config.settingsKeys), {
    ...config.overrides,
    ...options.overrides,
  })
  const files = new FileService({ db: database.db, settings, scanner: clamdScanner, store })
  // The intake source of the tenant and mailbox in effect is current before any job runs (plan 2.3, P18).
  await reconcileIntakeSource(database.db, settings)
  const graph = new GraphGateway()
  const intake = {
    pool: database.pool,
    settings,
    graph,
    sync: new IntakeSync({ db: database.db, settings, files, graph }),
    process: new IntakeProcessor({ db: database.db }),
    retry: new WaitingFiles({ db: database.db, settings, files, graph }),
  }
  // Sending reads the database through a pool of its own whose every statement is bounded, so an attempt cannot hang
  // on a read between its claim and its send (plan 3.1, review R3).
  const sending = openDatabase(config.databaseUrl, 2, { statementTimeoutMs: SEND_STATEMENT_TIMEOUT_MS })
  const sendSettings = new Settings(sending.db, createSettingsCipher(config.settingsKeys), {
    ...config.overrides,
    ...options.overrides,
  })
  const send = {
    db: database.db,
    settings,
    sender: new ReplySender({ db: sending.db, settings: sendSettings, timeouts: options.timeouts }),
    timeouts: options.timeouts,
  }

  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: "pgboss" })
  boss.on("error", (error) => log.error("the job queue reported an error", errorFacts(error)))
  await boss.start()
  await registerJobs(boss, { files, intake, send })
  log.info("worker started", { version: config.version })
  return {
    async stop() {
      await boss.stop({ graceful: true, timeout: 20_000 })
      await database.close()
      await sending.close()
    },
  }
}
