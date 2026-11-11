import { expect, test } from "@playwright/test"
import { ADMIN, he, password, signIn } from "./helpers.ts"
import { loadState, saveState } from "./state.ts"
import { freshTotp } from "./totp.ts"

// The first admin on a fresh stack, then sign-in with the password and a code. The desktop project creates the admin;
// the phone project, which runs after it, signs in. Tests in this file share the stack's state, so they run in order.
test.describe.configure({ mode: "serial" })

test("serves the UI in Hebrew, right to left, with its security headers", async ({ page, request }) => {
  const answer = await request.get("/")
  expect(answer.status()).toBe(200)
  expect(answer.headers()["content-security-policy"]).toContain("script-src 'self'")
  expect(answer.headers()["cache-control"]).toBe("no-store")

  await page.goto("/login")
  await expect(page.locator("html")).toHaveAttribute("lang", "he")
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
})

test("creates the first admin with two-factor and backup codes", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the desktop project creates the admin")
  expect(await (await request.get("/api/setup/status")).json()).toMatchObject({ hasUser: false, open: true })

  await page.goto("/setup")
  await page.getByLabel(he("auth.username"), { exact: true }).fill(ADMIN)
  await page.getByLabel(he("auth.password"), { exact: true }).fill(password())
  await page.getByLabel(he("auth.repeatPassword"), { exact: true }).fill(password())
  await page.getByRole("button", { name: he("setup.create"), exact: true }).click()

  // Two-factor: the secret the page shows, then a code made from it.
  const secret = ((await page.getByTestId("totp-secret").textContent()) ?? "").replace(/[^A-Z2-7]/g, "")
  expect(secret.length).toBeGreaterThanOrEqual(16)
  saveState({ secret })
  // The sixth digit sends the code.
  await page.getByLabel(he("auth.code"), { exact: true }).fill(await freshTotp(secret))

  // The backup codes, shown once.
  const list = page.getByTestId("backup-codes").locator("li")
  await expect(list.first()).toBeVisible()
  const codes = (await list.allTextContents()).map((code) => code.trim())
  expect(codes.length).toBeGreaterThan(0)
  saveState({ backupCodes: codes })
  const done = page.getByRole("button", { name: he("enroll.continue"), exact: true })
  await expect(done).toBeDisabled()
  await page.getByLabel(he("backupCodes.saved"), { exact: true }).check()
  await done.click()
  await expect(page).toHaveURL(/\/$/)

  expect(await (await request.get("/api/setup/status")).json()).toMatchObject({ hasUser: true, open: false })
})

test("closes setup once an admin exists", async ({ page }) => {
  await page.goto("/setup")
  await expect(page).toHaveURL(/\/login/)
})

test("signs in with the password and a code from the authenticator", async ({ page }) => {
  expect(loadState().secret).toBeTruthy()
  await signIn(page)
})

test("refuses a wrong password without saying whether the user exists", async ({ page }) => {
  await page.goto("/login")
  await page.getByLabel(he("auth.username"), { exact: true }).fill(ADMIN)
  await page.getByLabel(he("auth.password"), { exact: true }).fill(`${password()}x`)
  await page.getByRole("button", { name: he("login.submit"), exact: true }).click()
  await expect(page.getByRole("alert")).toBeVisible()
  await expect(page.getByLabel(he("auth.code"), { exact: true })).toHaveCount(0)
})
