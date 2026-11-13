import { randomBytes } from "node:crypto"
import { expect, type Page, test } from "@playwright/test"
import { en, fillSecret, freshAddress, he, signIn, waitShown } from "./helpers.ts"
import { totp } from "./totp.ts"

// An admin creates an organization with a support address and an agent member, in Hebrew and then in English; the
// agent cannot open the organization pages. The file makes its own agent, so it does not depend on another file.
test.describe.configure({ mode: "serial" })

const AGENT = "agent2"
const agentPassword = randomBytes(18).toString("base64url")
const ORGANIZATION = "Example Support"
const ADDRESS = "help@example.com"

/** The account button, found by its class: its name changes with the language. */
async function chooseLanguage(page: Page, language: "he" | "en") {
  await page.locator("button.ui-account-btn").filter({ visible: true }).first().click()
  await page.getByRole("menu").locator(`[role="menuitemradio"][lang="${language}"]`).click()
  await expect(page.locator("html")).toHaveAttribute("lang", language)
}

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "one project creates the organization")

  test("an admin creates an organization with an address and an agent member, in both languages", async ({ page }) => {
    await signIn(page)

    // The agent to add: made on the Users page, as an admin does.
    await page.goto("/users")
    await page.getByRole("button", { name: he("users.create"), exact: true }).click()
    const userDialog = page.getByRole("dialog")
    await userDialog.getByLabel(he("auth.username"), { exact: true }).fill(AGENT)
    await userDialog.getByRole("radio", { name: new RegExp(he("role.agent")) }).check()
    await fillSecret(userDialog.getByLabel(he("users.firstPassword"), { exact: true }), agentPassword)
    await fillSecret(userDialog.getByLabel(he("auth.repeatPassword"), { exact: true }), agentPassword)
    await userDialog.getByRole("button", { name: he("users.create"), exact: true }).click()
    await expect(userDialog).toHaveCount(0)
    // The page has finished its own work after the create (the list shows the new agent) before the test leaves it,
    // as users.spec.ts waits. A page.goto at once failed once with net::ERR_ABORTED (2026-11-12); it did not happen
    // again in about 150 tries of this sequence, so its cause is not known.
    await expect(page.getByText(AGENT, { exact: true })).toBeVisible()

    // The organization: Add organization opens it once it exists. The stack stage's intake made two already.
    await page.goto("/organizations")
    await expect(page.locator('a[data-organization="Example Alpha"]')).toBeVisible()
    await page.getByRole("button", { name: he("organizations.create"), exact: true }).click()
    const create = page.getByRole("dialog")
    await create.getByLabel(he("organizations.name"), { exact: true }).fill(ORGANIZATION)
    await create.getByRole("button", { name: he("organizations.create"), exact: true }).click()
    await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]{36}$/)
    await expect(page.locator(".ui-crumb-current")).toHaveText(ORGANIZATION)

    // An exact address, made the default.
    await page.getByRole("button", { name: he("organization.addresses.add"), exact: true }).click()
    const address = page.getByRole("dialog")
    await address.getByLabel(he("organization.addresses.value"), { exact: true }).fill(ADDRESS.toUpperCase())
    await address.getByRole("button", { name: he("organization.addresses.add"), exact: true }).click()
    await expect(address).toHaveCount(0)
    const row = page.locator(`[data-address="${ADDRESS}"]`)
    await expect(row).toBeVisible()
    await expect(row.locator('bdi[dir="ltr"]')).toHaveText(ADDRESS)
    await row.locator('button[aria-haspopup="menu"]').click()
    await page.getByRole("menuitem", { name: he("organization.addresses.setDefault"), exact: true }).click()
    await expect(row.getByText(he("organization.addresses.default"), { exact: true })).toBeVisible()

    // The agent.
    await page.getByRole("button", { name: he("organization.members.add"), exact: true }).click()
    const member = page.getByRole("dialog")
    await member.getByRole("radio", { name: new RegExp(AGENT) }).check()
    await member.getByRole("button", { name: he("organization.members.add"), exact: true }).click()
    await expect(member).toHaveCount(0)
    await expect(page.locator(`[data-member="${AGENT}"]`)).toBeVisible()

    // The list counts them, and the address check answers through the same rules as intake.
    await page.goto("/organizations")
    const listed = page.locator(`a[data-organization="${ORGANIZATION}"]`)
    await expect(listed).toContainText(he("organizations.holdsDefault"))
    await page.locator(".ui-check-form input").fill("someone@elsewhere.example.com")
    await page.getByRole("button", { name: he("organizations.check.submit"), exact: true }).click()
    await expect(page.locator(".ui-banner")).toContainText(ADDRESS)

    // The same pages in English, left to right.
    await chooseLanguage(page, "en")
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr")
    await expect(page.getByText(en("organizations.listTitle"), { exact: true })).toBeVisible()
    await listed.click()
    await expect(page.getByRole("heading", { name: en("organization.addresses.title"), exact: true })).toBeVisible()
    await expect(page.getByRole("heading", { name: en("organization.members.title"), exact: true })).toBeVisible()
    await expect(page.locator(`[data-address="${ADDRESS}"]`)).toContainText(en("organization.kind.exact"))
    await chooseLanguage(page, "he")
  })

  test("the agent cannot open the organization pages or their API", async ({ page }) => {
    await freshAddress(page)
    await page.goto("/login")
    await page.getByLabel(he("auth.username"), { exact: true }).fill(AGENT)
    await fillSecret(page.getByLabel(he("auth.password"), { exact: true }), agentPassword)
    await page.getByRole("button", { name: he("login.submit"), exact: true }).click()
    await waitShown(page, '[data-testid="totp-secret"]')
    const secret = ((await page.getByTestId("totp-secret").textContent()) ?? "").replace(/[^A-Z2-7]/g, "")
    await fillSecret(page.getByLabel(he("auth.code"), { exact: true }), totp(secret))
    await waitShown(page, '[data-testid="backup-codes"] li')
    await page.getByLabel(he("backupCodes.saved"), { exact: true }).check()
    await page.getByRole("button", { name: he("enroll.continue"), exact: true }).click()
    await expect(page).toHaveURL(/\/$/)

    await expect(page.locator(".ui-sidenav")).not.toContainText(he("nav.organizations"))
    await page.goto("/organizations")
    await expect(page.getByText(he("adminOnly.title"), { exact: true })).toBeVisible()
    expect((await page.request.get("/api/v1/admin/organizations")).status()).toBe(403)
    expect((await page.request.get("/api/v1/admin/organizations/address-check?address=a@example.com")).status()).toBe(
      403,
    )
  })
})

test.describe("phone", () => {
  test.skip(({ isMobile }) => !isMobile, "the phone project reads what the desktop project made")

  test("the organization fits the phone screen", async ({ page }) => {
    await signIn(page)
    await page.goto("/organizations")
    await page.locator(`a[data-organization="${ORGANIZATION}"]`).click()
    await expect(page.locator(`[data-address="${ADDRESS}"]`)).toBeVisible()
    await expect(page.locator(`[data-member="${AGENT}"]`)).toBeVisible()
    // Nothing is wider than the screen: the page never scrolls sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
