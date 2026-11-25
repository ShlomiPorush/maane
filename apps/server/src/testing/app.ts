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

export class TestClock {
  ms = 0
  now = () => this.ms
  advance(ms: number) {
    this.ms += ms
  }
}

const NO_JOBS: JobQueue = {
  send: async () => {
    throw new Error("this test has no job queue")
  },
  sendIn: async () => {
    throw new Error("this test has no job queue")
  },
  job: async () => null,
  pending: async () => null,
  stop: async () => {},
}

export function createTestApp(
  database: TestDatabase,
  overrides: Record<string, string> = {},
  jobs: JobQueue = NO_JOBS,
  filesDir = "/nonexistent",
  links: { trustedProxies?: string[]; geoipDir?: string | null } = {},
  vapidPublicKey = randomBytes(65).toString("base64url"),
  archiveDir = "/nonexistent",
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
    trustedProxies: links.trustedProxies ?? [],
    geoipDir: links.geoipDir ?? null,
    vapidPublicKey,
    archiveDir,
  })
  return {
    ready,
    clock,
    settings,
    fetch: async (request: Request, peer?: string) => {
      await ready
      return app.fetch(request, peer ? { incoming: { socket: { remoteAddress: peer }, headers: {} } } : undefined)
    },
    auth: () => auth,
    app,
    close: () => audit.close(),
  }
}
