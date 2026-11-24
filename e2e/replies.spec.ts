import { expect, type Page, test } from "@playwright/test"
import { he, signIn } from "./helpers.ts"

test.describe.configure({ mode: "serial" })

const BETA_SUBJECT = "Question for Beta"
const SHALOM_OLAM = `${String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd)} ${String.fromCodePoint(0x5e2, 0x5d5, 0x5dc, 0x5dd)}`
const ENGLISH = "The English paragraph of this reply."

function watchPolicy(page: Page): string[] {
  const violations: string[] = []
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text())
  })
  return violations
}

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "one project sends the reply")

  test("an agent sends a Hebrew reply with an English paragraph and a file, and it is accepted", async ({ page }) => {
    const violations = watchPolicy(page)
    await signIn(page)
    await page.goto("/")
    const row = page.locator("a.ui-ticket-row").filter({ hasText: BETA_SUBJECT }).first()
    await expect(row).toBeVisible()
    const number = Number(await row.getAttribute("data-number"))
    await row.click()
    await expect(page).toHaveURL(new RegExp(`/tickets/${number}$`))

    const composer = page.locator(".ui-composer")
    await expect(composer).toHaveAttribute("data-kind", "reply")
    await expect(composer.getByLabel(he("compose.to"), { exact: true })).toHaveValue("dana@example.com")
    await expect(composer.locator("select")).toHaveValue("beta@example.com")

    const editor = composer.getByTestId("composer-text")
    await editor.click()
    await page.keyboard.type(SHALOM_OLAM)
    await page.keyboard.press("Enter")
    await page.keyboard.type(ENGLISH)
    await expect(editor.locator("p")).toHaveCount(2)
    const directions = await editor
      .locator("p")
      .evaluateAll((paragraphs) => paragraphs.map((p) => [p.getAttribute("dir"), getComputedStyle(p).direction]))
    expect(directions).toEqual([
      ["auto", "rtl"],
      ["auto", "ltr"],
    ])

    await composer.locator('input[type="file"]').setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("The notes of the meeting.\n"),
    })
    await expect(composer.locator('.ui-file[data-file="notes.txt"]')).toHaveAttribute("data-state", "clean", {
      timeout: 60_000,
    })

    await expect(composer.getByTestId("composer-send")).toHaveText(he("compose.sendPending"))
    await composer.getByTestId("composer-send").click()
    await expect(page.getByText(he("compose.replyQueuedPending"))).toBeVisible()
    await expect(editor.locator("p")).toHaveCount(1)
    const status = page.getByTestId("ticket-status")
    await expect(status).toHaveValue("pending")

    const reply = page.locator('.ui-message[data-direction="out"]').last()
    await expect(async () => {
      await page.reload()
      await expect(reply.locator(".ui-delivery")).toHaveAttribute("data-state", "accepted", { timeout: 2_000 })
    }).toPass({ timeout: 90_000 })
    await expect(reply.locator('[data-recipient="dana@example.com"]')).toHaveAttribute("data-state", "accepted")
    await expect(reply).toContainText(he("delivery.provider.smtp2go"))
    await expect(reply.locator('.ui-file[data-file="notes.txt"]')).toBeVisible()
    const body = reply.frameLocator("iframe.ui-mail-frame")
    await expect(body.getByText(SHALOM_OLAM)).toBeVisible()
    await expect(body.getByText(ENGLISH)).toBeVisible()

    await composer.locator('button[data-kind="note"]').click()
    await editor.click()
    await page.keyboard.type("A note for the team.")
    await composer.getByTestId("composer-send").click()
    await expect(page.getByText(he("compose.noteAdded"))).toBeVisible()
    await expect(page.locator('.ui-message[data-direction="note"]').last()).toContainText(he("ticket.direction.note"))
    await expect(status).toHaveValue("pending")
    await status.selectOption("open")
    await expect(status).toHaveValue("open")
    await page.reload()
    await expect(page.getByTestId("ticket-status")).toHaveValue("open")
    expect(violations).toEqual([])
  })
})
