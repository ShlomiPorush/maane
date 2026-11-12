import { randomBytes } from "node:crypto"
import { expect, test } from "@playwright/test"
import { fillSecret, freshAddress, he, signIn, waitShown } from "./helpers.ts"
import { totp } from "./totp.ts"

// An admin adds an agent; the agent's first sign-in sets up two-factor, and admin pages stay closed to them.
test.describe.configure({ mode: "serial" })

const AGENT = "agent1"
const agentPassword = randomBytes(18).toString("base64url")

// The desktop project adds the agent; the phone project would add it twice.
test.skip(({ isMobile }) => isMobile, "one project adds the agent")

test("an admin adds an agent", async ({ page }) => {
  await signIn(page)
  await page.goto("/users")
  await page.getByRole("button", { name: he("users.create"), exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel(he("auth.username"), { exact: true }).fill(AGENT)
  await dialog.getByRole("radio", { name: new RegExp(he("role.agent")) }).check()
  await fillSecret(dialog.getByLabel(he("users.firstPassword"), { exact: true }), agentPassword)
  await fillSecret(dialog.getByLabel(he("auth.repeatPassword"), { exact: true }), agentPassword)
  await dialog.getByRole("button", { name: he("users.create"), exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText(AGENT, { exact: true })).toBeVisible()
})

test("the agent sets up two-factor on first sign-in and cannot open admin pages", async ({ page }) => {
  await freshAddress(page)
  await page.goto("/login")
  await page.getByLabel(he("auth.username"), { exact: true }).fill(AGENT)
  await fillSecret(page.getByLabel(he("auth.password"), { exact: true }), agentPassword)
  await page.getByRole("button", { name: he("login.submit"), exact: true }).click()

  const shown = page.getByTestId("totp-secret")
  await waitShown(page, '[data-testid="totp-secret"]')
  const secret = ((await shown.textContent()) ?? "").replace(/[^A-Z2-7]/g, "")
  // The sixth digit sends the code. The agent's secret is new, so any current code is unused.
  await fillSecret(page.getByLabel(he("auth.code"), { exact: true }), totp(secret))
  await waitShown(page, '[data-testid="backup-codes"] li')
  await page.getByLabel(he("backupCodes.saved"), { exact: true }).check()
  await page.getByRole("button", { name: he("enroll.continue"), exact: true }).click()
  await expect(page).toHaveURL(/\/$/)

  for (const path of ["/organizations", "/users", "/settings", "/audit"]) {
    await page.goto(path)
    await expect(page.getByText(he("adminOnly.title"), { exact: true })).toBeVisible()
  }
  expect((await page.request.get("/api/v1/settings")).status()).toBe(403)
  expect((await page.request.get("/api/v1/admin/organizations")).status()).toBe(403)
})
