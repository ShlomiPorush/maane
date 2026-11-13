import { expect, type Page, test } from "@playwright/test"
import { he, signIn } from "./helpers.ts"

// A reply through the composer (plan 3.1), against the stack's worker with stand-in SMTP servers in its own process
// (apps/worker/src/testing/stack-worker.ts, started by scripts/verify.sh for these tests): a Hebrew paragraph and an
// English one, each taking its own direction in the editor, and a file uploaded and scanned by the real ClamAV. The
// reply is sent through SMTP2GO's stand-in and accepted; verify.sh then checks what the stand-in received. Then an
// internal note. Intake goes live for the reply (live needs a default address: organizations.spec.ts made one) and
// back to listening at the end, as the stack stage leaves it. Every Content Security Policy violation fails the test.
test.describe.configure({ mode: "serial" })

const BETA_SUBJECT = "Question for Beta"
// "Shalom olam", from code points: only he.json holds Hebrew.
const SHALOM_OLAM = `${String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd)} ${String.fromCodePoint(0x5e2, 0x5d5, 0x5dc, 0x5dd)}`
const ENGLISH = "The English paragraph of this reply."
const ORIGIN = "http://127.0.0.1:8095"

function watchPolicy(page: Page): string[] {
  const violations: string[] = []
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text())
  })
  return violations
}

/** Saves one setting through the API, with the headers a change needs. */
async function setMode(page: Page, mode: "live" | "listening") {
  const answer = await page.request.put("/api/v1/settings", {
    data: { "intake.mode": mode },
    headers: { origin: ORIGIN, "x-maane-request": "1" },
  })
  expect(answer.status(), await answer.text()).toBe(200)
}

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "one project sends the reply")

  test("an agent sends a Hebrew reply with an English paragraph and a file, and it is accepted", async ({ page }) => {
    const violations = watchPolicy(page)
    await signIn(page)
    await setMode(page, "live")
    try {
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
      // Each paragraph takes the direction of its first letter.
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

      await composer.getByTestId("composer-send").click()
      await expect(page.getByText(he("compose.replyQueued"))).toBeVisible()
      await expect(editor.locator("p")).toHaveCount(1)

      // The worker sends it; the page shows each recipient's state once it reads the ticket again.
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

      // An internal note: never sent, shown apart.
      await composer.locator('button[data-kind="note"]').click()
      await editor.click()
      await page.keyboard.type("A note for the team.")
      await composer.getByTestId("composer-send").click()
      await expect(page.getByText(he("compose.noteAdded"))).toBeVisible()
      await expect(page.locator('.ui-message[data-direction="note"]').last()).toContainText(he("ticket.direction.note"))
      expect(violations).toEqual([])
    } finally {
      await setMode(page, "listening")
    }
  })
})
