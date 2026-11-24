import { loadConfig } from "@maane/server/config"
import { openDatabase } from "@maane/server/db/client"
import { PUSH_NOTIFY } from "@maane/server/jobs/queue"
import { errorFacts, log } from "@maane/server/log"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import type { SettingKey } from "@maane/shared"
import { PgBoss } from "pg-boss"
import { ActivityPoll } from "./delivery/poll.ts"
import { clamdScanner } from "./files/scanner.ts"
import { FileService } from "./files/service.ts"
import { FileStore } from "./files/store.ts"
import { ZendeskImport } from "./import/run.ts"
import { GraphGateway } from "./intake/graph.ts"
import { reconcileIntakeSource } from "./intake/jobs.ts"
import { IntakeProcessor, type Notify } from "./intake/process.ts"
import { WaitingFiles } from "./intake/retry.ts"
import { IntakeSync } from "./intake/sync.ts"
import { registerJobs } from "./jobs.ts"
import { PushNotifier } from "./notify/push.ts"
import { ReplySender } from "./send/sender.ts"
import type { SmtpTimeouts } from "./send/smtp.ts"

export const SEND_STATEMENT_TIMEOUT_MS = 30_000

export interface WorkerOptions {
  overrides?: Partial<Record<SettingKey, string>>
  timeouts?: SmtpTimeouts
}

export async function startWorker(options: WorkerOptions = {}): Promise<{ stop(): Promise<void> }> {
  const config = loadConfig()
  const store = new FileStore(config.filesDir)
  await store.prepare()
  const database = openDatabase(config.databaseUrl, 5)
  const settings = new Settings(database.db, createSettingsCipher(config.settingsKeys), {
    ...config.overrides,
    ...options.overrides,
  })
  const files = new FileService({ db: database.db, settings, scanner: clamdScanner, store })
  await reconcileIntakeSource(database.db, settings)
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: "pgboss" })
  boss.on("error", (error) => log.error("the job queue reported an error", errorFacts(error)))
  const notify: Notify = async (jobs, job) => {
    const id = await boss.send(PUSH_NOTIFY, job, { db: jobs })
    if (!id) throw new Error("the queue did not accept a push-notify job")
  }
  const graph = new GraphGateway()
  const intake = {
    pool: database.pool,
    settings,
    graph,
    sync: new IntakeSync({ db: database.db, settings, files, graph }),
    process: new IntakeProcessor({ db: database.db, notify }),
    retry: new WaitingFiles({ db: database.db, settings, files, graph }),
  }
  const sending = openDatabase(config.databaseUrl, 2, { statementTimeoutMs: SEND_STATEMENT_TIMEOUT_MS })
  const sendSettings = new Settings(sending.db, createSettingsCipher(config.settingsKeys), {
    ...config.overrides,
    ...options.overrides,
  })
  const send = {
    db: database.db,
    settings,
    sender: new ReplySender({
      db: sending.db,
      settings: sendSettings,
      queue: (jobs, name, data, startAfter) => boss.send(name, data, { db: jobs, startAfter }),
      timeouts: options.timeouts,
    }),
    poll: new ActivityPoll({ db: database.db, settings }),
    timeouts: options.timeouts,
  }

  const push = new PushNotifier({ db: database.db, vapid: config.vapid, publicUrl: config.publicUrl })

  await boss.start()
  const zendeskImport = {
    pool: database.pool,
    importer: new ZendeskImport({ db: database.db, files, archiveDir: config.archiveDir }),
  }
  await registerJobs(boss, { files, intake, send, push, zendeskImport })
  log.info("worker started", { version: config.version })
  return {
    async stop() {
      await boss.stop({ graceful: true, timeout: 20_000 })
      await database.close()
      await sending.close()
    },
  }
}
