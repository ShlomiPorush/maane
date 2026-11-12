import { randomBytes } from "node:crypto"
import { type Auth, createAuth } from "../auth/auth.ts"
import { SetupWindow } from "../auth/setup-window.ts"
import { openDatabase } from "../db/client.ts"
import { createApp } from "../http/app.ts"
import type { JobQueue } from "../jobs/queue.ts"
import { createSettingsCipher } from "../settings/crypto.ts"
import { Settings } from "../settings/service.ts"
import { TEST_ORIGIN } from "./browser.ts"
import type { createTestDatabase } from "./db.ts"

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>

/** A clock the tests move by hand: the setup window reads it. */
export class TestClock {
  ms = 0
  now = () => this.ms
  advance(ms: number) {
    this.ms += ms
  }
}

/** A queue for tests that never queue a job: any attempt fails the test. */
const NO_JOBS: JobQueue = {
  send: async () => {
    throw new Error("this test has no job queue")
  },
  job: async () => null,
  stop: async () => {},
}

/**
 * The app as the server builds it, on a test database, with keys new for this run and a movable clock. Requests go
 * straight to `app.fetch`, so no port is opened.
 */
export function createTestApp(
  database: TestDatabase,
  overrides: Record<string, string> = {},
  jobs: JobQueue = NO_JOBS,
  /** The file store the ticket routes read; tests that serve files give a temporary directory. */
  filesDir = "/nonexistent",
) {
  const audit = openDatabase(database.url, 2)
  const clock = new TestClock()
  const setup = new SetupWindow(clock.now)
  const publicUrl = new URL(TEST_ORIGIN)
  const settings = new Settings(
    database.db,
    createSettingsCipher([{ version: 1, value: randomBytes(32).toString("hex") }]),
    overrides,
  )
  const secrets = [{ version: 1, value: randomBytes(32).toString("hex") }]
  let auth: Auth
  const build = async () => {
    auth = createAuth({
      db: database.db,
      auditDb: audit.db,
      secrets,
      publicUrl,
      trustedProxies: [],
      setup,
      sessionDays: await settings.get("security.sessionDays"),
    })
  }
  const ready = build()
  const app = createApp({
    db: database.db,
    auth: () => auth,
    settings,
    setup,
    publicUrl,
    webDir: "/nonexistent",
    filesDir,
    version: "test",
    onSettingsChanged: build,
    jobs,
  })
  return {
    ready,
    clock,
    settings,
    fetch: async (request: Request) => {
      await ready
      return app.fetch(request)
    },
    auth: () => auth,
    close: () => audit.close(),
  }
}
