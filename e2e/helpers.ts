import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, type Locator, type Page } from "@playwright/test"
import { loadState, saveState } from "./state.ts"
import { freshTotp } from "./totp.ts"

export const ADMIN = "admin"

type Messages = { [key: string]: string | Messages }

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

export function he(key: string, values: Record<string, string | number> = {}): string {
  return lookup("he", key, values)
}

export function en(key: string, values: Record<string, string | number> = {}): string {
  return lookup("en", key, values)
}

export async function fillSecret(field: Locator, value: string): Promise<void> {
  await field.clear()
  await field.page().keyboard.insertText(value)
}

export function password(): string {
  const value = loadState().password
  if (!value) throw new Error("no password for this run: global-setup.ts did not run")
  return value
}

export async function freshAddress(page: Page): Promise<void> {
  const n = (loadState().addresses ?? 0) + 1
  if (n > 200) throw new Error("more sign-ins than documentation addresses")
  saveState({ addresses: n })
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${n + 50}` })
}

export async function signIn(page: Page): Promise<void> {
  const secret = loadState().secret
  if (!secret) throw new Error("no TOTP secret: the setup test did not run")
  await freshAddress(page)
  await page.goto("/login")
  await page.getByLabel(he("auth.username"), { exact: true }).fill(ADMIN)
  await fillSecret(page.getByLabel(he("auth.password"), { exact: true }), password())
  await page.getByRole("button", { name: he("login.submit"), exact: true }).click()
  await fillSecret(page.getByLabel(he("auth.code"), { exact: true }), await freshTotp(secret))
  await expect(page).toHaveURL(/\/$/)
}

export async function waitShown(page: Page, selector: string): Promise<void> {
  await expect.poll(() => page.locator(selector).first().isVisible()).toBe(true)
}
