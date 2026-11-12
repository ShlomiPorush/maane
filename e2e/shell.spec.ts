import { expect, type Page, test } from "@playwright/test"
import { he, signIn } from "./helpers.ts"

// The shell after sign-in: both languages with their direction, and both themes, through the account menu, which
// every width shows.
test.describe.configure({ mode: "serial" })

/** The account button, found by its class: its name changes with the language. */
async function openAccountMenu(page: Page) {
  await page.locator("button.ui-account-btn").filter({ visible: true }).first().click()
  return page.getByRole("menu")
}

test("switches between Hebrew right to left and English left to right", async ({ page }) => {
  await signIn(page)
  const html = page.locator("html")
  await expect(html).toHaveAttribute("dir", "rtl")
  await (await openAccountMenu(page)).locator('[role="menuitemradio"][lang="en"]').click()
  await expect(html).toHaveAttribute("lang", "en")
  await expect(html).toHaveAttribute("dir", "ltr")
  await (await openAccountMenu(page)).locator('[role="menuitemradio"][lang="he"]').click()
  await expect(html).toHaveAttribute("lang", "he")
  await expect(html).toHaveAttribute("dir", "rtl")
})

test("follows the system's dark theme, and keeps light or dark when chosen", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await signIn(page)
  const html = page.locator("html")
  await expect(html).toHaveClass(/\bdark\b/)
  await (await openAccountMenu(page)).getByRole("menuitemradio", { name: he("theme.light"), exact: true }).click()
  await expect(html).not.toHaveClass(/\bdark\b/)
  await page.emulateMedia({ colorScheme: "light" })
  await (await openAccountMenu(page)).getByRole("menuitemradio", { name: he("theme.dark"), exact: true }).click()
  await expect(html).toHaveClass(/\bdark\b/)
  await (await openAccountMenu(page)).getByRole("menuitemradio", { name: he("theme.system"), exact: true }).click()
  await expect(html).not.toHaveClass(/\bdark\b/)
})
