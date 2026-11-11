import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, type Page } from "@playwright/test"
import { loadState } from "./state.ts"
import { freshTotp } from "./totp.ts"

/** The first admin's username in every run: the stack is new each time. */
export const ADMIN = "admin"

type Messages = { [key: string]: string | Messages }

// The UI's default language is Hebrew: the tests read its strings from the locale file, the only tracked place with
// Hebrew text.
const messages = JSON.parse(
  readFileSync(fileURLToPath(new URL("../packages/shared/src/locales/he.json", import.meta.url)), "utf8"),
) as Messages

/** The Hebrew text of a locale key, with `{name}` placeholders filled. */
export function he(key: string, values: Record<string, string | number> = {}): string {
  let node: string | Messages | undefined = messages
  for (const part of key.split(".")) node = typeof node === "object" ? node[part] : undefined
  if (typeof node !== "string") throw new Error(`he.json has no text for ${key}`)
  return node.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`))
}

/** The admin's password made for this run by global-setup.ts. */
export function password(): string {
  const value = loadState().password
  if (!value) throw new Error("no password for this run: global-setup.ts did not run")
  return value
}

/** Signs in through the UI with the password and a TOTP code of a step no earlier test used. */
export async function signIn(page: Page): Promise<void> {
  const secret = loadState().secret
  if (!secret) throw new Error("no TOTP secret: the setup test did not run")
  await page.goto("/login")
  await page.getByLabel(he("auth.username"), { exact: true }).fill(ADMIN)
  await page.getByLabel(he("auth.password"), { exact: true }).fill(password())
  await page.getByRole("button", { name: he("login.submit"), exact: true }).click()
  // The sixth digit sends the code.
  await page.getByLabel(he("auth.code"), { exact: true }).fill(await freshTotp(secret))
  await expect(page).toHaveURL(/\/$/)
}
