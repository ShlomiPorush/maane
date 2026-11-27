import { expect, type Page, test } from "@playwright/test"
import { he, signIn } from "./helpers.ts"

const INVOICE = String.fromCodePoint(0x5d7, 0x5e9, 0x5d1, 0x5d5, 0x5e0, 0x5d9, 0x5ea)

function countLoads(page: Page): () => number {
  let loads = 0
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loads++
  })
  return () => loads
}

async function pageAssets(page: Page): Promise<{ script: string; stylesheet: string }> {
  const html = await (await page.request.get("/login")).text()
  const script = /<script type="module"[^>]*src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]
  const stylesheet = /<link rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1]
  if (!script || !stylesheet) throw new Error("the page names no hashed script or stylesheet")
  return { script, stylesheet }
}

test("a hashed asset that is gone answers 404 that no cache keeps, not the page", async ({ request }) => {
  const response = await request.get("/assets/index-gone0000.js")
  expect(response.status()).toBe(404)
  expect(response.headers()["cache-control"]).toBe("no-store")
  expect(response.headers()["content-type"]).not.toMatch(/text\/html/)
})

test("a page whose script fails once, as across a release switch, reloads once and starts", async ({ page }) => {
  const { script } = await pageAssets(page)
  let failed = false
  await page.route(`**${script}`, (route) => {
    if (failed) return route.continue()
    failed = true
    return route.fulfill({ status: 404, body: "Not found" })
  })
  const loads = countLoads(page)
  await page.goto("/login")
  await expect(page.getByLabel(he("auth.username"), { exact: true })).toBeVisible()
  expect(failed).toBe(true)
  expect(loads()).toBe(2)
})

test("a stylesheet that keeps failing reloads the page once and then leaves it", async ({ page }) => {
  const { stylesheet } = await pageAssets(page)
  let failures = 0
  await page.route(`**${stylesheet}`, (route) => {
    failures++
    return route.fulfill({ status: 404, body: "Not found" })
  })
  const loads = countLoads(page)
  await page.goto("/login")
  await expect.poll(() => failures).toBe(2)
  await page.waitForLoadState("load")
  await page.waitForTimeout(2000)
  expect(loads()).toBe(2)
  expect(failures).toBe(2)
})

test("a lazily loaded chunk that fails in an open tab reloads the page once", async ({ page, isMobile }) => {
  test.skip(isMobile, "the desktop project opens the ticket")
  await signIn(page)
  await page.goto("/")
  const row = page.locator("a.ui-ticket-row").filter({ hasText: INVOICE }).first()
  await row.click()
  await expect(page).toHaveURL(/\/tickets\/\d+$/)
  const ticketUrl = page.url()
  await page.waitForLoadState("load")
  let failed = false
  await page.route("**/assets/*.js", (route) => {
    if (failed) return route.continue()
    failed = true
    return route.fulfill({ status: 404, body: "Not found" })
  })
  const loads = countLoads(page)
  await page
    .locator(`[data-file="${INVOICE}.pdf"]`)
    .getByRole("button", { name: he("ticket.preview") })
    .click()
  await expect.poll(() => loads()).toBe(1)
  await page.waitForLoadState("load")
  expect(failed).toBe(true)
  expect(page.url()).toBe(ticketUrl)
})
