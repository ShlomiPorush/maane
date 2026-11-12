import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SYSTEM } from "../audit.ts"
import { auditLog, setting } from "../db/schema.ts"
import { createTestDatabase, testKey } from "../testing/db.ts"
import { createSettingsCipher } from "./crypto.ts"
import { Settings, SettingsError } from "./service.ts"

let database: Awaited<ReturnType<typeof createTestDatabase>>
beforeAll(async () => {
  database = await createTestDatabase()
})
afterAll(async () => {
  await database.drop()
})

const cipher = () => createSettingsCipher([{ version: 1, value: testKey() }])

describe("settings", () => {
  it("reads defaults, stores a change with its audit row, and reads it back", async () => {
    const settings = new Settings(database.db, cipher(), {})
    expect(await settings.get("security.sessionDays")).toBe(14)
    await settings.update({ "security.sessionDays": 30 }, SYSTEM)
    expect(await settings.get("security.sessionDays")).toBe(30)
    const audit = await database.db.select().from(auditLog)
    expect(audit.at(-1)).toMatchObject({ action: "setting.update", entityId: "security.sessionDays" })
  })

  it("refuses a locked field, an invalid value, and an unknown key, and writes nothing", async () => {
    const settings = new Settings(database.db, cipher(), { "general.defaultLocale": "en" })
    const before = (await database.db.select().from(setting)).length
    await expect(settings.update({ "general.defaultLocale": "he" }, SYSTEM)).rejects.toMatchObject({
      code: "setting_locked",
    })
    await expect(settings.update({ "security.sessionDays": 0 }, SYSTEM)).rejects.toBeInstanceOf(SettingsError)
    await expect(settings.update({ "nope.key": 1 }, SYSTEM)).rejects.toMatchObject({ code: "setting_unknown" })
    expect((await database.db.select().from(setting)).length).toBe(before)

    const view = await settings.view()
    expect(view.find((v) => v.key === "general.defaultLocale")).toMatchObject({
      value: "en",
      locked: true,
      variable: "MAANE_DEFAULT_LOCALE",
    })
  })
})
