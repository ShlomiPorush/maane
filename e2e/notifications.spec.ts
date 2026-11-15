import { expect, test } from "@playwright/test"
import { he, signIn } from "./helpers.ts"

// Chromium itself: Playwright's default headless shell reports notifications as denied even once they are allowed.
test.use({ channel: "chromium" })

// The PWA and browser notifications (plan 4.5) in the stack: the manifest and the service worker are served as files
// (not the UI's fallback page), the service worker registers, and the Account page offers notifications for this
// device. Nothing here subscribes: a real subscription would reach a browser vendor's push service.

test("serves the manifest and the service worker, and offers notifications on the Account page", async ({
  page,
  request,
}) => {
  const manifest = await request.get("/manifest.webmanifest")
  expect(manifest.status()).toBe(200)
  expect(manifest.headers()["content-type"]).toContain("application/manifest+json")
  const parsed = (await manifest.json()) as { start_url: string; display: string; icons: { src: string }[] }
  expect(parsed).toMatchObject({ start_url: "/", display: "standalone" })
  for (const icon of parsed.icons) expect((await request.get(icon.src)).status(), icon.src).toBe(200)
  const worker = await request.get("/sw.js")
  expect(worker.headers()["content-type"]).toContain("javascript")
  expect(await worker.text()).toContain("notificationclick")

  // Allow notifications, as a user does when the browser asks.
  await page.context().grantPermissions(["notifications"])
  await signIn(page)
  await page.goto("/account")
  const group = page.locator("#account-notifications")
  await expect(group).toContainText(he("notifications.group"))
  await expect(group).toContainText(he("notifications.off"))
  await expect(group.getByRole("button", { name: he("notifications.turnOn"), exact: true })).toBeEnabled()
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(new URL(scope).pathname).toBe("/")
})
