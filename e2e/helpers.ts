import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, type Locator, type Page } from "@playwright/test"
import { loadState, saveState } from "./state.ts"
import { freshTotp } from "./totp.ts"

/** The first admin's username in every run: the stack is new each time. */
export const ADMIN = "admin"

type Messages = { [key: string]: string | Messages }

// The UI's default language is Hebrew: the tests read its strings from the locale files, the only tracked place with
// Hebrew text, and English from its own file for the pages they check in both languages.
const load = (locale: "he" | "en") =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../packages/shared/src/locales/${locale}.json`, import.meta.url)), "utf8"),
  ) as Messages
const messages = { he: load("he"), en: load("en") }

function lookup(locale: "he" | "en", key: string, values: Record<string, string | number>): string {
  let node: string | Messages | undefined = messages[locale]
  for (const part of key.split(".")) node = typeof node === "object" ? node[part] : undefined
  if (typeof node !== "string") throw new Error(`${locale}.json has no text for ${key}`)
  return node.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`))
}

/** The Hebrew text of a locale key, with `{name}` placeholders filled. */
export function he(key: string, values: Record<string, string | number> = {}): string {
  return lookup("he", key, values)
}

/** The English text of a locale key, with `{name}` placeholders filled. */
export function en(key: string, values: Record<string, string | number> = {}): string {
  return lookup("en", key, values)
}

/**
 * Types a password or a code into a field without Playwright writing it down: `fill` puts its value in the call log,
 * which a failing test prints (`- fill("...")`) to the console and so to the CI log. `clear` waits for the field as
 * `fill` does and logs only `fill("")`; `keyboard.insertText` then types into the focused field, and its value
 * appears only in step titles, which the list reporter does not print.
 */
export async function fillSecret(field: Locator, value: string): Promise<void> {
  await field.clear()
  await field.page().keyboard.insertText(value)
}

/** The admin's password made for this run by global-setup.ts. */
export function password(): string {
  const value = loadState().password
  if (!value) throw new Error("no password for this run: global-setup.ts did not run")
  return value
}

/**
 * Gives the page's requests an address of their own: Better Auth allows 5 sign-ins per 5 minutes per client address,
 * which it reads from X-Forwarded-For here. Addresses come from the documentation range 198.51.100.0/24.
 */
export async function freshAddress(page: Page): Promise<void> {
  const n = (loadState().addresses ?? 0) + 1
  if (n > 200) throw new Error("more sign-ins than documentation addresses")
  saveState({ addresses: n })
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${n + 50}` })
}

/** Signs in through the UI with the password and a TOTP code of a step no earlier test used. */
export async function signIn(page: Page): Promise<void> {
  const secret = loadState().secret
  if (!secret) throw new Error("no TOTP secret: the setup test did not run")
  await freshAddress(page)
  await page.goto("/login")
  await page.getByLabel(he("auth.username"), { exact: true }).fill(ADMIN)
  await fillSecret(page.getByLabel(he("auth.password"), { exact: true }), password())
  await page.getByRole("button", { name: he("login.submit"), exact: true }).click()
  // The sixth digit sends the code.
  await fillSecret(page.getByLabel(he("auth.code"), { exact: true }), await freshTotp(secret))
  await expect(page).toHaveURL(/\/$/)
}

/**
 * Waits until an element that shows a secret (the TOTP secret, backup codes) is visible, as Playwright judges it. A
 * failed `expect(locator)` on such an element would print its text in the call log; polling `isVisible()` reports
 * only true or false.
 */
export async function waitShown(page: Page, selector: string): Promise<void> {
  await expect.poll(() => page.locator(selector).first().isVisible()).toBe(true)
}
