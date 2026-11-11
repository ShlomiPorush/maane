import { expect, test } from "@playwright/test"

// The server as a browser meets it before anyone signs in: the page and its security headers, and the setup status.
test("serves the UI with its Content Security Policy and opens setup on a fresh stack", async ({ request }) => {
  const page = await request.get("/")
  expect(page.status()).toBe(200)
  expect(page.headers()["content-type"]).toContain("text/html")
  expect(page.headers()["content-security-policy"]).toContain("script-src 'self'")
  expect(page.headers()["cache-control"]).toBe("no-store")

  const status = await request.get("/api/setup/status")
  expect(await status.json()).toMatchObject({ hasUser: false, open: true })
})
