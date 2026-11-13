import { randomBytes } from "node:crypto"
import { type Browser, expect, type Page, test } from "@playwright/test"
import { en, fillSecret, freshAddress, he, signIn, waitShown } from "./helpers.ts"
import { totp } from "./totp.ts"

// Tickets that intake made from the stand-in Graph in the stack stage (apps/worker/src/testing/stack-intake.ts, which
// runs before these tests; keep the names below in step with its FIXTURES): the list, a ticket's framed body in
// Hebrew right to left and in English, the remote images switch, what a scan blocked, image, PDF, and text previews,
// the intake log, and an agent of another organization, who gets 404 for every route of a ticket that is not theirs.
// The framed body is read inside the browser, so the body route's policy and frame headers are proven to let it
// render. Every Content Security Policy violation the browser reports fails the test.
test.describe.configure({ mode: "serial" })

// Hebrew from code points: only he.json holds Hebrew. "Shalom olam" and "heshbonit" (an invoice), as stack-intake.ts
// builds them through apps/worker/src/testing/mime.ts.
const SHALOM_OLAM = `${String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd)} ${String.fromCodePoint(0x5e2, 0x5d5, 0x5dc, 0x5dd)}`
const INVOICE = String.fromCodePoint(0x5d7, 0x5e9, 0x5d1, 0x5d5, 0x5e0, 0x5d9, 0x5ea)
const HEBREW_SUBJECT = `${SHALOM_OLAM} - ${INVOICE}`
const ENGLISH = "Question about the invoice"
const BLOCKED_FILE = "Blocked attachment"
const BLOCKED_TEXT = "Blocked text"
const BETA_SUBJECT = "Question for Beta"
const BETA = "Example Beta"
const SCANNED = "Scanned documents"

const AGENT = "agent3"
const agentPassword = randomBytes(18).toString("base64url")

/** Fails the test on any report of a Content Security Policy violation, in the page or in a frame. */
function watchPolicy(page: Page): string[] {
  const violations: string[] = []
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text())
  })
  return violations
}

async function chooseLanguage(page: Page, language: "he" | "en") {
  await page.locator("button.ui-account-btn").filter({ visible: true }).first().click()
  await page.getByRole("menu").locator(`[role="menuitemradio"][lang="${language}"]`).click()
  await expect(page.locator("html")).toHaveAttribute("lang", language)
}

/** Opens a ticket of the list by its subject; returns its number. */
async function openTicket(page: Page, subject: string): Promise<number> {
  await page.goto("/")
  const row = page.locator("a.ui-ticket-row").filter({ hasText: subject }).first()
  await expect(row).toBeVisible()
  const number = Number(await row.getAttribute("data-number"))
  await row.click()
  await expect(page).toHaveURL(new RegExp(`/tickets/${number}$`))
  return number
}

const frame = (page: Page) => page.frameLocator("iframe.ui-mail-frame").first()

/** Waits until an image has been decoded by the browser: its natural width is above zero. */
async function decoded(locator: ReturnType<Page["locator"]>) {
  await expect
    .poll(() => locator.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth))
    .toBeGreaterThan(0)
}

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "the desktop project reads every ticket")

  test("a ticket intake made shows in the list and opens, its Hebrew body right to left in its frame", async ({
    page,
  }) => {
    const violations = watchPolicy(page)
    await signIn(page)
    await openTicket(page, HEBREW_SUBJECT)
    await expect(page.locator(".ui-facts")).toContainText("Example Alpha")
    await expect(page.locator('.ui-facts bdi[dir="ltr"]').first()).toHaveText("alpha@example.com")

    // The body renders inside the sandboxed frame: the route's policy and frame headers allow it.
    const body = frame(page).locator("body")
    await expect(body).toHaveAttribute("dir", "rtl")
    await expect(frame(page).getByText(SHALOM_OLAM, { exact: false }).first()).toBeVisible()
    expect(await body.evaluate((element) => getComputedStyle(element).direction)).toBe("rtl")
    // The inline image is the message's own clean part; the remote one is not there until it is allowed.
    await decoded(frame(page).locator('img[alt="logo"]'))
    await expect(frame(page).locator('img[alt="banner"]')).toHaveCount(0)
    await page.getByRole("button", { name: he("ticket.showImages"), exact: true }).click()
    await expect(page.locator("iframe.ui-mail-frame").first()).toHaveAttribute("src", /[?&]images=1$/)
    await expect(frame(page).locator('img[alt="banner"]')).toHaveCount(1)
    await expect(page.getByRole("button", { name: he("ticket.hideImages"), exact: true })).toBeVisible()

    // A link in the frame opens in a new tab with its own address, cut off from Maane; the ticket stays as it was.
    const ticketUrl = page.url()
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      frame(page).getByRole("link", { name: "Service status", exact: true }).click(),
    ])
    await popup.waitForLoadState()
    expect(popup.url()).toBe("http://127.0.0.1:8095/healthz/live")
    expect(await popup.evaluate(() => window.opener === null)).toBe(true)
    await popup.close()
    expect(page.url()).toBe(ticketUrl)
    // A link of another scheme keeps its words but no address.
    await expect(frame(page).getByText("Call us", { exact: true })).not.toHaveAttribute("href", /.*/)

    // An image preview: the browser decodes the file the preview route serves.
    await page
      .locator('[data-file="photo.png"]')
      .getByRole("button", { name: he("ticket.preview") })
      .click()
    const imageDialog = page.getByRole("dialog")
    await decoded(imageDialog.locator("img.ui-preview-image"))
    await page.keyboard.press("Escape")
    await expect(imageDialog).toHaveCount(0)

    // A PDF preview: pdf.js draws the page on a canvas, its worker from Maane's own origin.
    await page
      .locator(`[data-file="${INVOICE}.pdf"]`)
      .getByRole("button", { name: he("ticket.preview") })
      .click()
    const pdfDialog = page.getByRole("dialog")
    await expect(pdfDialog.locator('canvas[data-rendered="1"]')).toBeVisible({ timeout: 20_000 })
    const painted = await pdfDialog
      .locator("canvas")
      .evaluate((canvas: HTMLCanvasElement) => canvas.width > 0 && canvas.height > 0)
    expect(painted).toBe(true)
    await page.keyboard.press("Escape")

    // The same ticket in English, left to right; the Hebrew body keeps its own direction.
    await chooseLanguage(page, "en")
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr")
    await expect(page.getByRole("heading", { name: en("ticket.details"), exact: true })).toBeVisible()
    await expect(frame(page).locator("body")).toHaveAttribute("dir", "rtl")
    await chooseLanguage(page, "he")
    expect(violations).toEqual([])
  })

  test("an English message, a blocked file, and a blocked text show as they are", async ({ page }) => {
    const violations = watchPolicy(page)
    await signIn(page)

    await openTicket(page, ENGLISH)
    await expect(frame(page).locator("body")).toHaveAttribute("dir", "ltr")
    await expect(frame(page).getByText("Can you check it?")).toBeVisible()
    await page
      .locator('[data-file="notes.txt"]')
      .getByRole("button", { name: he("ticket.preview") })
      .click()
    await expect(page.getByRole("dialog").locator("pre.ui-preview-text")).toContainText("Line two of the notes.")
    await page.keyboard.press("Escape")

    await openTicket(page, BLOCKED_FILE)
    const infected = page.locator('[data-file="readme.txt"]')
    await expect(infected).toContainText(he("scan.status.infected"))
    await expect(infected.locator('bdi[dir="ltr"]')).toContainText(/Eicar/i)
    await expect(infected.locator("a[download]")).toHaveCount(0)
    await expect(infected.getByRole("button")).toHaveCount(0)
    // Markup downloads only.
    const drawing = page.locator('[data-file="drawing.svg"]')
    await expect(drawing.locator("a[download]")).toHaveCount(1)
    await expect(drawing.getByRole("button", { name: he("ticket.preview") })).toHaveCount(0)

    await openTicket(page, BLOCKED_TEXT)
    const notice = page.locator('[data-field="text"]')
    await expect(notice).toContainText(he("scan.status.infected"))
    await expect(notice.locator('bdi[dir="ltr"]')).toContainText(/Eicar/i)
    await expect(frame(page).getByText("The formatted version of this message is fine.")).toBeVisible()
    expect(violations).toEqual([])
  })

  test("PDF previews draw scans, faxes, and embedded fonts, and say that the download holds the original", async ({
    page,
  }) => {
    const violations = watchPolicy(page)
    await signIn(page)
    await openTicket(page, SCANNED)
    /** Opens a file's PDF preview, waits until its page is drawn, and counts the page's dark pixels. */
    const drawn = async (fileName: string) => {
      await page
        .locator(`[data-file="${fileName}"]`)
        .getByRole("button", { name: he("ticket.preview") })
        .click()
      const dialog = page.getByRole("dialog")
      const canvas = dialog.locator('canvas[data-rendered="1"]')
      await expect(canvas).toBeVisible({ timeout: 20_000 })
      const dark = await canvas.evaluate((element: HTMLCanvasElement) => {
        const context = element.getContext("2d")
        if (!context) return -1
        const { data } = context.getImageData(0, 0, element.width, element.height)
        let count = 0
        for (let i = 0; i < data.length; i += 4)
          if ((data[i] ?? 255) < 90 && (data[i + 1] ?? 255) < 90 && (data[i + 2] ?? 255) < 90) count++
        return count
      })
      return { dialog, dark }
    }
    // The images of a scan (JBIG2) and a fax (CCITT): pdf.js decodes them with its own decoders, served from Maane's
    // origin, and draws their black band.
    for (const fileName of ["scan-jbig2.pdf", "fax-ccitt.pdf", "embedded-font.pdf"]) {
      const { dialog, dark } = await drawn(fileName)
      expect(dark, fileName).toBeGreaterThan(1000)
      // pdf.js says nothing when it leaves a part out: every PDF preview says the download holds the original.
      await expect(dialog.getByTestId("pdf-note")).toHaveText(he("ticket.pdfNote"))
      await page.keyboard.press("Escape")
      await expect(dialog).toHaveCount(0)
    }
    expect(violations).toEqual([])
  })

  test("the intake log shows what intake did, and what it would have done while listening", async ({ page }) => {
    await signIn(page)
    await page.goto("/intake")
    // Rows are told apart by their mode and outcome: one word of an outcome can be part of another's.
    const listeningJoined = page.locator('.ui-intake-row[data-mode="listening"][data-outcome="joined"]')
    await expect(listeningJoined).toHaveCount(1)
    await expect(listeningJoined).toContainText(he("intake.outcomeWould.joined"))
    const automated = page.locator('.ui-intake-row[data-mode="live"][data-outcome="automated"]')
    await expect(automated).toHaveCount(1)
    await expect(automated).toContainText(he("intake.outcome.automated"))
    await page.getByRole("button", { name: he("intake.mode.listening"), exact: true }).click()
    await expect(page).toHaveURL(/\/intake\?mode=listening$/)
    await expect(page.locator('.ui-intake-row[data-mode="live"]')).toHaveCount(0)
    await expect(listeningJoined).toHaveCount(1)
  })

  test("an agent of another organization gets 404 for a ticket, its body, and its files", async ({ page, browser }) => {
    await signIn(page)
    // What the agent will ask for: Alpha's ticket, one of its messages, and one of its files.
    const alpha = await openTicket(page, HEBREW_SUBJECT)
    const view = await (await page.request.get(`/api/v1/tickets/${alpha}`)).json()
    const messageId: string = view.messages[0].id
    const fileId: string = view.messages[0].attachments.find((file: { preview: string | null }) => file.preview).id
    const beta = await openTicket(page, BETA_SUBJECT)

    // The agent, a member of Beta only.
    await page.goto("/users")
    await page.getByRole("button", { name: he("users.create"), exact: true }).click()
    const userDialog = page.getByRole("dialog")
    await userDialog.getByLabel(he("auth.username"), { exact: true }).fill(AGENT)
    await userDialog.getByRole("radio", { name: new RegExp(he("role.agent")) }).check()
    await fillSecret(userDialog.getByLabel(he("users.firstPassword"), { exact: true }), agentPassword)
    await fillSecret(userDialog.getByLabel(he("auth.repeatPassword"), { exact: true }), agentPassword)
    await userDialog.getByRole("button", { name: he("users.create"), exact: true }).click()
    await expect(userDialog).toHaveCount(0)
    await expect(page.getByText(AGENT, { exact: true })).toBeVisible()
    await page.goto("/organizations")
    await page.locator(`a[data-organization="${BETA}"]`).click()
    await page.getByRole("button", { name: he("organization.members.add"), exact: true }).click()
    const member = page.getByRole("dialog")
    await member.getByRole("radio", { name: new RegExp(AGENT) }).check()
    await member.getByRole("button", { name: he("organization.members.add"), exact: true }).click()
    await expect(page.locator(`[data-member="${AGENT}"]`)).toBeVisible()

    const agent = await agentPage(browser)
    await agent.goto("/")
    await expect(agent.locator(`a[data-number="${beta}"]`)).toBeVisible()
    await expect(agent.locator(`a[data-number="${alpha}"]`)).toHaveCount(0)
    for (const path of [
      `/api/v1/tickets/${alpha}`,
      `/api/v1/messages/${messageId}/body`,
      `/api/v1/files/${fileId}`,
      `/api/v1/files/${fileId}/preview`,
    ]) {
      expect((await agent.request.get(path)).status(), path).toBe(404)
      expect((await page.request.get(path)).status(), path).toBe(200)
    }
    expect((await agent.request.get(`/api/v1/tickets/${beta}`)).status()).toBe(200)
    await agent.goto(`/tickets/${alpha}`)
    await expect(agent.getByTestId("ticket-missing")).toContainText(he("ticket.notFound"))
    await agent.context().close()
  })
})

/** The agent's own browser: the first sign-in sets up two-factor. */
async function agentPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:8095" })
  const page = await context.newPage()
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
  return page
}

test.describe("phone", () => {
  test.skip(({ isMobile }) => !isMobile, "the phone project reads what the stack made")

  test("the list, a ticket, and the intake log fit the phone, and More holds the pages that do not fit", async ({
    page,
  }) => {
    const violations = watchPolicy(page)
    await signIn(page)
    await openTicket(page, HEBREW_SUBJECT)
    await expect(frame(page).locator("body")).toHaveAttribute("dir", "rtl")
    await expect(frame(page).getByText(SHALOM_OLAM, { exact: false }).first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    // An admin has six pages: four tabs (the intake log among them), and More with the other two.
    const tabs = page.locator(".ui-tabbar")
    await tabs.getByRole("link", { name: he("nav.intake") }).click()
    await expect(page).toHaveURL(/\/intake$/)
    await expect(page.locator(".ui-intake-row").first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await tabs.getByRole("button", { name: he("nav.more") }).click()
    await page.getByRole("menuitem", { name: he("nav.audit") }).click()
    await expect(page).toHaveURL(/\/audit$/)
    expect(violations).toEqual([])
  })
})
