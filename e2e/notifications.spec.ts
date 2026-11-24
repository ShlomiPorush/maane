import { expect, test } from "@playwright/test"
import { he, signIn } from "./helpers.ts"

test.use({ channel: "chromium" })

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
