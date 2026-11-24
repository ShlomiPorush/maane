import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "*.spec.ts",
  globalSetup: fileURLToPath(new URL("./global-setup.ts", import.meta.url)),
  // A failed test's error-context.md holds an ARIA snapshot of the page: field values, the TOTP secret, and backup
  // codes. It stays in the container's temporary directory, which goes with the container; never point this at a
  // mounted directory or upload it. Traces and screenshots stay off for the same reason.
  outputDir: join(tmpdir(), "maane-e2e"),
  reporter: "list",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A sign-in may wait up to 30 seconds for a TOTP step no earlier test used.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:8095",
    trace: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: { "x-forwarded-for": "198.51.100.21" },
      },
    },
    {
      name: "phone",
      dependencies: ["desktop"],
      use: { ...devices["Pixel 7"], extraHTTPHeaders: { "x-forwarded-for": "198.51.100.22" } },
    },
  ],
})
