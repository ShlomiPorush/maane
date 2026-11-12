// @vitest-environment node
// Guard tests of the v3 style and of Maane's language policy, over the web sources (adapted from Mikud):
// - every popup comes from its shared builder (DS-24): a dialog, sheet, menu, toast or other layer made anywhere else
//   fails, as does a CSS rule that floats a selector not listed here;
// - every page has a refresh of its own (SV-10), or is listed with the reason it has none;
// - no page formats a date itself (FW-9);
// - every locale key the code uses exists in both locale files, and every dynamic key family is complete;
// - no Hebrew and no literal bidirectional control character in apps/web (Hebrew lives only in he.json);
// - the page loads nothing from another origin and has no inline script or style (the server's CSP forbids both);
// - every setting the server registers has a place on the Settings page;
// - every audit action the server's and the worker's writeAudit calls can write has its words on the audit page.
// Each check is a function over file texts, so the self-tests show it catches a planted bypass.

import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import {
  ADDRESS_KINDS,
  INTAKE_MODES,
  MESSAGES,
  ROLES,
  SCANNER_CHECKS,
  SCANNER_POLICIES,
  SETTING_KEYS,
} from "@maane/shared"
import { describe, expect, it } from "vitest"
import { ERROR_TEXT, STATUS_TEXT } from "./api/errors.ts"
import { AUDIT_ACTIONS } from "./pages/AuditPage.tsx"
import { labelKey, SETTING_ROWS } from "./pages/SettingsPage.tsx"
import { NAV } from "./shell/navigation.ts"
import { THEMES } from "./shell/theme.ts"

const SRC = fileURLToPath(new URL(".", import.meta.url))
const APP = fileURLToPath(new URL("..", import.meta.url))
const { en, he } = MESSAGES

function walk(dir: string, accept: (name: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue
      Object.assign(out, walk(full, accept))
    } else if (accept(entry.name)) {
      out[relative(SRC, full).replaceAll("\\", "/")] = readFileSync(full, "utf8")
    }
  }
  return out
}

/** The app's sources without tests, keyed by their path under src/. */
const files = walk(SRC, (name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))

/** Every text file of apps/web, tests included, keyed by path under apps/web. */
function allAppFiles(): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") visit(full)
      } else if (/\.(ts|tsx|js|json|html|css|svg)$/.test(entry.name)) {
        out[relative(APP, full).replaceAll("\\", "/")] = readFileSync(full, "utf8")
      }
    }
  }
  visit(APP)
  return out
}

/** Source text without comments, so a rule explained in a comment does not count as code. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
}

// --- Popups (DS-24) ---

/** The files that may build a layer over the page, each with its reason. */
const BUILDERS: Record<string, string> = {
  "ui/Dialog.tsx": "the one dialog builder; on phones every dialog is a bottom sheet (DS-1, DS-24)",
  "ui/Toast.tsx": "the one toast (FB-2)",
  "ui/layers.ts": "owns Escape, Back, focus and the inert page behind every layer (DS-8, DS-10, DS-11)",
  "ui/Menu.tsx": "the one menu (the account menu, a user's actions), anchored to its button (MP-7)",
}

/** Files that may portal and nothing else: they move a page's own elements into the frame, not a layer. */
const PORTAL_ONLY: Record<string, string> = {
  "shell/chrome.tsx": "PageActions moves the page's own action buttons into the top bar from 761px (NL-6)",
}

/** CSS selectors that may float above the page, each with its reason. */
const FLOATING_CSS: Record<string, string> = {
  ".ui-dialog-backdrop": "every dialog and phone sheet",
  ".ui-toast": "the toast",
  ".ui-tabbar": "the phone tab bar, part of the frame",
  ".ui-savebar": "the save bar, part of the page",
  ".ui-menu-backdrop": "the click-outside area of a menu",
  ".ui-menu": "a menu, placed beside its button",
}

const LAYER_PATTERNS: [string, RegExp][] = [
  ["a portal", /\bcreatePortal\s*\(/],
  ["a dialog role", /role\s*[=:]\s*\{?\s*["'](?:alert)?dialog["']/],
  ["a <dialog> element", /<dialog\b/],
  ["showModal()", /\.showModal\s*\(/],
  ["a popover attribute", /\bpopover\s*[=:]/],
  ["a menu role", /role\s*[=:]\s*\{?\s*["']menu(?:item(?:radio|checkbox)?)?["']/],
  ["a listbox role", /role\s*[=:]\s*\{?\s*["'](?:listbox|option|combobox)["']/],
  ["a layer frame class", /["'`\s]ui-(?:dialog|toast|menu)(?:[-\s"'`]|$)/m],
  ["fixed positioning", /position\s*:\s*["']fixed["']|\.position\s*=\s*["']fixed["']/],
  ["the browser's alert, confirm or prompt", /(?<![\w.$])(?:window\.)?(?:alert|confirm|prompt)\s*\(/],
]

/** The opening tag of a JSX element at `start`, braces balanced, so `() =>` inside a value does not end it. */
function openingTag(text: string, start: number): string {
  let depth = 0
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (char === "{") depth++
    else if (char === "}") depth--
    else if (char === ">" && depth === 0) return text.slice(start, index + 1)
  }
  return text.slice(start)
}

function popupViolations(sources: Record<string, string>): string[] {
  const found: string[] = []
  for (const [file, text] of Object.entries(sources)) {
    if (file in BUILDERS) continue
    // A <Dialog ...> call is the builder itself: its role and props are not a layer made by hand.
    let plain = code(text)
    for (let start = plain.indexOf("<Dialog"); start !== -1; start = plain.indexOf("<Dialog")) {
      plain = plain.slice(0, start) + plain.slice(start + openingTag(plain, start).length)
    }
    for (const [name, pattern] of LAYER_PATTERNS) {
      if (name === "a portal" && file in PORTAL_ONLY) continue
      if (pattern.test(plain)) found.push(`${file}: ${name} outside the shared builders`)
    }
  }
  return found
}

function dialogCallViolations(sources: Record<string, string>): string[] {
  const found: string[] = []
  for (const [file, text] of Object.entries(sources)) {
    for (const match of code(text).matchAll(/<Dialog\b/g)) {
      const tag = openingTag(code(text), match.index ?? 0)
      if (!/\bsize=/.test(tag)) found.push(`${file}: a Dialog without a size`)
      const question = /role="alertdialog"/.test(tag)
      if (question ? !/\bonCancel=/.test(tag) : !/\bonClose=/.test(tag))
        found.push(`${file}: a Dialog without its close function`)
    }
  }
  return found
}

function floatingCssViolations(css: string): string[] {
  const found: string[] = []
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "")
  for (const match of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? "").trim()
    const body = match[2] ?? ""
    const fixed = /position\s*:\s*fixed/.test(body)
    const zIndex = Number(/z-index\s*:\s*(\d+)/.exec(body)?.[1] ?? 0)
    const absoluteHigh = /position\s*:\s*absolute/.test(body) && zIndex >= 20
    if (!fixed && !absoluteHigh) continue
    for (const selector of selectors.split(",").map((part) => part.trim())) {
      const head = /^\.[\w-]+/.exec(selector)?.[0] ?? selector
      if (!(head in FLOATING_CSS)) found.push(`ui.css: ${selector} floats but is not a listed layer`)
    }
  }
  return found
}

// --- Page refresh (SV-10) ---

/** Pages without a refresh of their own, each with its reason. */
const NO_REFRESH: Record<string, string> = {
  HomePage: "says there are no tickets yet; it reads nothing until tickets arrive in phase 2",
  NotFoundPage: "says the address names no page; it reads nothing",
  LoginPage: "signs in; it reads whether a user exists and the session once, on opening",
  SetupPage: "creates the first admin; it reads the setup state on opening and after each step",
  EnrollPage: "sets up two-factor; it reads the session once, on opening",
}
const NOT_PAGES = new Set(["Root", "Shell", "Component"])

function routedPages(routes: string): Record<string, string> {
  const imports = new Map<string, string>()
  for (const match of routes.matchAll(/import \{ (\w+) \} from "\.\/(pages\/[\w/]+)\.tsx"/g))
    imports.set(match[1] ?? "", `${match[2]}.tsx`)
  const names = new Set<string>()
  for (const match of routes.matchAll(/Component: ([A-Z]\w*Page)\b/g)) names.add(match[1] ?? "")
  for (const match of routes.matchAll(/element: <(\w+) \/>/g)) names.add(match[1] ?? "")
  const pages: Record<string, string> = {}
  for (const name of names) {
    if (NOT_PAGES.has(name)) continue
    pages[name] = imports.get(name) ?? `missing import for ${name}`
  }
  return pages
}

const REFRESH = /\busePage(?:Infinite)?Query(?:<[^>]*>)?\(\s*\{[\s\S]*?\bevery:/

function refreshViolations(routes: string, sources: Record<string, string>): string[] {
  const found: string[] = []
  for (const [name, file] of Object.entries(routedPages(routes))) {
    const text = sources[file]
    if (text === undefined) {
      found.push(`${name}: ${file}`)
      continue
    }
    const refreshes = REFRESH.test(code(text))
    if (!refreshes && !(name in NO_REFRESH))
      found.push(`${name} (${file}) has no refresh of its own and is not listed in NO_REFRESH`)
    if (refreshes && name in NO_REFRESH) found.push(`${name} refreshes now: take it off NO_REFRESH`)
  }
  return found
}

// --- Dates (FW-9) ---

const DATE_HELPERS = new Set(["format/datetime.ts"])
const OWN_DATES =
  /\.toLocale(?:Date|Time)String\(|Intl\.DateTimeFormat|\.get(?:Hours|Minutes|Seconds|Date|Day|Month|FullYear)\(|\bhour12\b|\bhourCycle\b|\bdateStyle\b|\btimeStyle\b|new Date\([^)]*\)\.toLocaleString\(/

function dateViolations(sources: Record<string, string>): string[] {
  return Object.entries(sources)
    .filter(([file, text]) => !DATE_HELPERS.has(file) && OWN_DATES.test(code(text)))
    .map(([file]) => `${file} formats a date itself; use src/format/datetime.ts`)
}

// --- Locale keys ---

function leaf(tree: unknown, key: string): boolean {
  let node: unknown = tree
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return false
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === "string"
}

const inBoth = (key: string) => leaf(en, key) && leaf(he, key)

/** The first argument of a call that starts at `open` (just after its parenthesis), parentheses and braces balanced. */
function firstArgument(text: string, open: number): string {
  let depth = 0
  for (let index = open; index < text.length; index++) {
    const char = text[index]
    if (char === "(" || char === "{" || char === "[") depth++
    else if (char === ")" || char === "}" || char === "]") {
      if (depth === 0) return text.slice(open, index)
      depth--
    } else if (char === "," && depth === 0) return text.slice(open, index)
  }
  return text.slice(open)
}

/** Every key a t() or tc() call can ask for: each dotted literal in its first argument (also in a condition). */
function usedKeys(sources: Record<string, string>): { plain: Set<string>; counted: Set<string>; dynamic: Set<string> } {
  const plain = new Set<string>()
  const counted = new Set<string>()
  const dynamic = new Set<string>()
  for (const text of Object.values(sources)) {
    const plainText = code(text)
    for (const call of plainText.matchAll(/\b(tc?)\(/g)) {
      const argument = firstArgument(plainText, (call.index ?? 0) + call[0].length)
      const into = call[1] === "tc" ? counted : plain
      for (const literal of argument.matchAll(/"(\w+(?:\.\w+)+)"/g)) into.add(literal[1] ?? "")
      for (const template of argument.matchAll(/`(\w+(?:\.\w+)*\.)\$\{/g)) dynamic.add(template[1] ?? "")
    }
  }
  return { plain, counted, dynamic }
}

/** Every family of keys the code builds at run time, and the full list of what it may build. */
const DYNAMIC_FAMILIES: Record<string, readonly string[]> = {
  "theme.": THEMES,
  "role.": ROLES,
  "nav.": NAV.map((page) => page.id),
  "users.roleHint.": ROLES,
  "audit.action.": AUDIT_ACTIONS,
  "audit.stage.": ["password", "second_factor"],
  "time.ago.": ["min.one", "min.other", "h.one", "h.other", "d.one", "d.other"],
  "organization.kind.": ADDRESS_KINDS,
  "organization.kindHint.": ADDRESS_KINDS,
  "organizations.check.": ["exact", "pattern", "default"],
  "settings.intakeMode.mode.": INTAKE_MODES,
  "settings.intakeMode.explain.": INTAKE_MODES,
  "settings.scannerPolicy.mode.": SCANNER_POLICIES,
  "settings.scannerPolicy.explain.": SCANNER_POLICIES,
  "settings.scanner.check.": SCANNER_CHECKS,
}

// --- Language policy: Hebrew only in he.json, bidirectional controls only as escapes ---

// Built from code points: this file itself holds no Hebrew and no control character.
const HEBREW = new RegExp(
  `[${String.fromCodePoint(0x590)}-${String.fromCodePoint(0x5ff)}${String.fromCodePoint(0xfb1d)}-${String.fromCodePoint(0xfb4f)}]`,
)
const BIDI = new RegExp(
  `[${[0x61c, 0x200e, 0x200f].map((c) => String.fromCodePoint(c)).join("")}${String.fromCodePoint(0x202a)}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2066)}-${String.fromCodePoint(0x2069)}]`,
)

function languageViolations(sources: Record<string, string>): string[] {
  const found: string[] = []
  for (const [file, text] of Object.entries(sources)) {
    if (HEBREW.test(text)) found.push(`${file}: Hebrew text; it belongs in packages/shared/src/locales/he.json`)
    if (BIDI.test(text)) found.push(`${file}: a literal bidirectional control character; write it as a code point`)
  }
  return found
}

// --- Content Security Policy: nothing from another origin, no inline script or style ---

function cspViolations(html: string, css: string, sources: Record<string, string>): string[] {
  const found: string[] = []
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) found.push("index.html: an inline script")
  if (/<style\b/i.test(html)) found.push("index.html: an inline <style>")
  if (/\sstyle="/i.test(html)) found.push("index.html: a style attribute")
  if (/(?:src|href)=["'](?:https?:)?\/\//i.test(html)) found.push("index.html: a file from another origin")
  if (/@import\s+url\(["']?https?:|url\(["']?https?:/i.test(css)) found.push("ui.css: a file from another origin")
  for (const [file, text] of Object.entries(sources)) {
    if (/\b(?:fetch|import)\(\s*["'`]https?:/.test(code(text))) found.push(`${file}: a request to another origin`)
    if (/dangerouslySetInnerHTML/.test(code(text))) found.push(`${file}: raw HTML`)
  }
  return found
}

// --- The tests ---

const css = readFileSync(join(SRC, "styles/ui.css"), "utf8")
const routes = readFileSync(join(SRC, "routes.tsx"), "utf8")
const html = readFileSync(join(APP, "index.html"), "utf8")

describe("popups come from their shared builders (DS-24)", () => {
  it("no layer is built outside the builders, and every Dialog names its size and close", () => {
    expect(popupViolations(files)).toEqual([])
    expect(dialogCallViolations(files)).toEqual([])
  })

  it("only listed selectors float above the page", () => {
    expect(floatingCssViolations(css)).toEqual([])
  })

  it("every listed builder and floating selector still exists", () => {
    for (const file of [...Object.keys(BUILDERS), ...Object.keys(PORTAL_ONLY)]) expect(files[file], file).toBeDefined()
    for (const selector of Object.keys(FLOATING_CSS)) expect(css.includes(`${selector} {`), selector).toBe(true)
  })

  it("catches a planted bypass of each kind", () => {
    const page = (body: string) => ({ "pages/Planted.tsx": body })
    expect(popupViolations(page(`return <div role="dialog" aria-modal="true">x</div>`))).toHaveLength(1)
    expect(popupViolations(page(`return createPortal(<div />, document.body)`))).toHaveLength(1)
    expect(popupViolations(page(`if (window.confirm("Delete?")) remove()`))).toHaveLength(1)
    expect(popupViolations(page(`return <div className="ui-dialog-backdrop" />`))).toHaveLength(1)
    expect(popupViolations(page(`const style = { position: "fixed", inset: 0 }`))).toHaveLength(1)
    expect(popupViolations(page(`return <dialog open>x</dialog>`))).toHaveLength(1)
    expect(popupViolations(page(`return <div role="menu"><b role="menuitem">x</b></div>`))).toHaveLength(1)
    expect(popupViolations(page(`return <div role="listbox"><b role="option">x</b></div>`))).toHaveLength(1)
    expect(
      popupViolations(page(`<Menu anchor={b} label="Account" entries={[]} side="top" align="end" onClose={f} />`)),
    ).toEqual([])
    expect(popupViolations({ "shell/chrome.tsx": "return createPortal(children, actionsSlot)" })).toEqual([])
    expect(popupViolations({ "shell/chrome.tsx": `return <div role="dialog">x</div>` })).toHaveLength(1)
    expect(popupViolations(page(`await confirmDialog({ title: "x" })`))).toEqual([])
    expect(popupViolations(page(`<Dialog role="alertdialog" size="sm" onCancel={f}>x</Dialog>`))).toEqual([])
    expect(dialogCallViolations(page(`<Dialog title="x" onClose={() => close()}>body</Dialog>`))).toEqual([
      "pages/Planted.tsx: a Dialog without a size",
    ])
    expect(dialogCallViolations(page(`<Dialog size="sm" title="x">body</Dialog>`))).toEqual([
      "pages/Planted.tsx: a Dialog without its close function",
    ])
    expect(floatingCssViolations(`.ui-new-layer { position: fixed; inset: 0; }`)).toHaveLength(1)
    expect(floatingCssViolations(`.ui-tip { position: absolute; z-index: 40; }`)).toHaveLength(1)
    expect(floatingCssViolations(`.ui-pip { position: absolute; }`)).toEqual([])
  })
})

describe("every page has a refresh of its own (SV-10)", () => {
  it("each routed page reads with a pace, or is listed with its reason", () => {
    expect(refreshViolations(routes, files)).toEqual([])
  })

  it("every page listed without a refresh is still a page", () => {
    const pages = routedPages(routes)
    for (const name of Object.keys(NO_REFRESH)) expect(pages[name], name).toBeDefined()
  })

  it("catches a page without a refresh", () => {
    const planted = `import { PlantedPage } from "./pages/PlantedPage.tsx"\nconst PAGES = [{ id: "x", path: "/x", Component: PlantedPage }]`
    expect(
      refreshViolations(planted, { "pages/PlantedPage.tsx": "export function PlantedPage() { return null }" }),
    ).toHaveLength(1)
    expect(
      refreshViolations(planted, {
        "pages/PlantedPage.tsx": "usePageQuery({ queryKey: k, queryFn: f, every: EVERY.live })",
      }),
    ).toEqual([])
  })
})

describe("dates go through the format helpers (FW-9)", () => {
  it("no page formats a date itself", () => {
    expect(dateViolations(files)).toEqual([])
  })

  it("catches a page that formats a date itself", () => {
    expect(dateViolations({ "pages/Planted.tsx": "new Date(at).toLocaleDateString()" })).toHaveLength(1)
    expect(dateViolations({ "pages/Planted.tsx": "new Intl.DateTimeFormat('en').format(d)" })).toHaveLength(1)
  })
})

describe("locale keys", () => {
  const { plain, counted, dynamic } = usedKeys(files)

  it("every key the code uses exists in both languages", () => {
    expect([...plain].filter((key) => !inBoth(key))).toEqual([])
  })

  it("every counted key has its one, two and other forms in both languages", () => {
    const missing = [...counted].filter((key) => !["one", "two", "other"].every((form) => inBoth(`${key}.${form}`)))
    expect(missing).toEqual([])
  })

  it("every key the code builds at run time belongs to a listed family, and each family is complete", () => {
    expect([...dynamic].filter((prefix) => !(prefix in DYNAMIC_FAMILIES))).toEqual([])
    for (const [prefix, members] of Object.entries(DYNAMIC_FAMILIES)) {
      expect(
        members.filter((member) => !inBoth(`${prefix}${member}`)),
        prefix,
      ).toEqual([])
    }
  })

  it("every key of the error table, the setting labels and the language names exists", () => {
    const keys = [
      ...Object.values(ERROR_TEXT),
      ...Object.values(STATUS_TEXT),
      ...SETTING_ROWS.map(labelKey),
      "language.self",
    ]
    expect(keys.filter((key) => !inBoth(key))).toEqual([])
  })

  it("finds the keys in the sources (the scan itself works)", () => {
    expect(plain.has("login.title")).toBe(true)
    expect(counted.has("savebar.count")).toBe(true)
    expect(dynamic.has("audit.action.")).toBe(true)
    // A key chosen by a condition counts too.
    expect(plain.has("users.makeAgent")).toBe(true)
    expect(plain.has("login.backupDescription")).toBe(true)
  })

  it("catches a planted key in a condition, in a counted call, and in a template", () => {
    const found = usedKeys({
      "pages/Planted.tsx": `t(on ? "planted.yes" : "planted.no", { n: f("x.y") }); tc("planted.count", 2); t(\`planted.kind.\${k}\`)`,
    })
    expect([...found.plain].sort()).toEqual(["planted.no", "planted.yes"])
    expect([...found.counted]).toEqual(["planted.count"])
    expect([...found.dynamic]).toEqual(["planted.kind."])
  })
})

describe("language policy", () => {
  it("apps/web holds no Hebrew and no literal bidirectional control character", () => {
    expect(languageViolations(allAppFiles())).toEqual([])
  })

  it("catches planted Hebrew and a planted control character", () => {
    const hebrew = String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd)
    expect(languageViolations({ "src/Planted.tsx": `const title = "${hebrew}"` })).toHaveLength(1)
    expect(languageViolations({ "src/Planted.tsx": `const mark = "${String.fromCodePoint(0x200f)}"` })).toHaveLength(1)
    expect(languageViolations({ "src/Planted.tsx": "const isolate = String.fromCodePoint(0x2068)" })).toEqual([])
  })
})

describe("the server's Content Security Policy holds", () => {
  it("the page loads nothing from another origin and has no inline script or style", () => {
    expect(cspViolations(html, css, files)).toEqual([])
  })

  it("catches a planted inline script, inline style, and remote file", () => {
    expect(cspViolations("<script>boot()</script>", "", {})).toHaveLength(1)
    expect(cspViolations("<style>body{}</style>", "", {})).toHaveLength(1)
    expect(cspViolations(`<link href="https://fonts.example.com/x.css">`, "", {})).toHaveLength(1)
    expect(cspViolations("", "@import url(https://fonts.example.com/x.css);", {})).toHaveLength(1)
    expect(cspViolations(`<script src="/boot.js"></script>`, "", {})).toEqual([])
  })
})

describe("settings", () => {
  it("every setting the server registers has a place on the Settings page", () => {
    expect([...SETTING_KEYS].sort()).toEqual([...SETTING_ROWS].sort())
  })
})

// --- Audit actions: every action the server can write has its words ---

const SERVER_SRC = fileURLToPath(new URL("../../server/src/", import.meta.url))
const WORKER_SRC = fileURLToPath(new URL("../../worker/src/", import.meta.url))

/** The server's and the worker's sources without tests (the worker's by a path from the server's, ../../worker/). */
function serverFiles(): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
        out[relative(SERVER_SRC, full).replaceAll("\\", "/")] = readFileSync(full, "utf8")
    }
  }
  visit(SERVER_SRC)
  visit(WORKER_SRC)
  return out
}

/** Every argument of a call, from just after its opening parenthesis to its closing one. */
function callArguments(text: string, open: number): string {
  let depth = 0
  for (let index = open; index < text.length; index++) {
    const char = text[index]
    if (char === "(" || char === "{" || char === "[") depth++
    else if (char === ")" || char === "}" || char === "]") {
      if (depth === 0) return text.slice(open, index)
      depth--
    }
  }
  return text.slice(open)
}

/**
 * The actions the server's writeAudit calls can write: literals after `action:` (also in a condition), and the values
 * of a `*_AUDIT` map that an `action` read from it. An action the scan cannot read (any other expression), or an
 * audit row inserted without writeAudit, is reported, so a new writer cannot hide from the check.
 */
function auditActionsWritten(sources: Record<string, string>): { actions: Set<string>; unread: string[] } {
  const actions = new Set<string>()
  const unread: string[] = []
  for (const [file, raw] of Object.entries(sources)) {
    const text = code(raw)
    if (file !== "audit.ts" && /\.insert\(\s*auditLog\b/.test(text))
      unread.push(`${file}: inserts an audit row without writeAudit`)
    const maps = new Map<string, string[]>()
    for (const map of text.matchAll(/\bconst (\w+_AUDIT)\b[^=]*=\s*\{([^}]*)\}/g))
      maps.set(
        map[1] ?? "",
        [...(map[2] ?? "").matchAll(/:\s*"([^"]+)"/g)].map((value) => value[1] ?? ""),
      )
    for (const call of text.matchAll(/\b(function\s+)?writeAudit\(/g)) {
      if (call[1]) continue // the declaration in audit.ts
      const rest = callArguments(text, (call.index ?? 0) + call[0].length)
      const expressions = [
        ...[...rest.matchAll(/\baction:\s*([^,\n}]+)/g)].map((match) => (match[1] ?? "").trim()),
        ...[...rest.matchAll(/[{,]\s*(action)\s*[,}]/g)].map((match) => match[1] ?? ""),
      ]
      if (expressions.length === 0) {
        unread.push(`${file}: writeAudit without an action the scan can read; write it out in the call`)
        continue
      }
      for (const expression of expressions) {
        const literals = [...expression.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "")
        if (literals.length > 0) {
          for (const literal of literals) actions.add(literal)
          continue
        }
        const bound = /^\w+$/.test(expression)
          ? new RegExp(`\\b(?:const|let)\\s+${expression}\\s*=\\s*(\\w+_AUDIT)\\[`).exec(text)
          : null
        const values = bound ? maps.get(bound[1] ?? "") : undefined
        if (values) for (const value of values) actions.add(value)
        else unread.push(`${file}: writeAudit with action ${expression}; use a literal or a *_AUDIT map`)
      }
    }
  }
  return { actions, unread }
}

describe("audit actions", () => {
  const { actions, unread } = auditActionsWritten(serverFiles())

  it("every action the server can write has its words on the audit page", () => {
    expect(unread).toEqual([])
    expect([...actions].filter((action) => !(AUDIT_ACTIONS as readonly string[]).includes(action))).toEqual([])
  })

  it("reads literals, conditions and both kinds of map lookups (the scan itself works)", () => {
    for (const action of ["setting.update", "account.totp_disable", "session.revoke_others", "user.set_role"])
      expect(actions.has(action)).toBe(true)
  })

  it("catches a planted action, an unreadable one, and an audit row written by hand", () => {
    const planted = auditActionsWritten({
      "a.ts": `const NEW_AUDIT: Record<string, string> = { "/x": "planted.map" }
        const action = NEW_AUDIT[path]
        await writeAudit(db, actor, { action, entityType: "user" })
        await writeAudit(db, actor, { action: on ? "planted.yes" : "planted.no" })
        await writeAudit(db, actor, { action: pick(path), entityType: "user" })
        await writeAudit(db, actor, entry)`,
      "b.ts": "await db.insert(auditLog).values({ action: 'planted.raw' })",
      "audit.ts": "export async function writeAudit(db: Db, actor: Actor, entry: AuditEntry) {}",
    })
    expect([...planted.actions].sort()).toEqual(["planted.map", "planted.no", "planted.yes"])
    expect(planted.unread).toHaveLength(3)
  })
})
