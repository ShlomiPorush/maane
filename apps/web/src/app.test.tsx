// The app's routes in a DOM, against a stand-in for Maane's API and Better Auth's client: where each session state
// and role lands (signed out, two-factor off, agent, admin), the setup screen's states, sign-in with its second
// step, and a session that ends while a page is open. Texts are read from the locale files.

import { SEARCH_MAX_LENGTH } from "@maane/shared"
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { noteAuthStatus } from "./api/auth.ts"
import { setTransport, type TransportRequest, type TransportResponse } from "./api/client.ts"
import { ERROR_VARS } from "./api/errors.ts"
import { FSI, I18nProvider, PDI, translate, translateCount } from "./i18n/i18n.tsx"
import { browserDevice, type DeviceSubscription, setPushDevice } from "./notifications/device.ts"
import { ROUTES } from "./routes.tsx"

/** pdf.js, as the PDF preview loads it (pages/tickets/pdf.ts): component tests never run it. */
const pdf = vi.hoisted(() => ({ loadPdfJs: vi.fn(), openPdf: vi.fn() }))
vi.mock("./pages/tickets/pdf.ts", () => ({ loadPdfJs: pdf.loadPdfJs, openPdf: pdf.openPdf }))

const auth = vi.hoisted(() => ({
  listUsers: vi.fn(),
  listSessions: vi.fn(),
  signInUsername: vi.fn(),
  verifyTotp: vi.fn(),
  verifyBackupCode: vi.fn(),
  generateBackupCodes: vi.fn(),
  signUpEmail: vi.fn(),
  revokeOtherSessions: vi.fn(),
  disable: vi.fn(),
  enable: vi.fn(),
  signOut: vi.fn(),
}))

/** Better Auth's client session as useSession reads it, changed by a test the way another tab or a refresh does. */
const session = vi.hoisted(() => {
  type Data = { session: { id: string }; user: { id: string; role: string } } | null
  let data: Data = null
  const listeners = new Set<() => void>()
  return {
    get: () => data,
    set(next: Data) {
      data = next
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
})

vi.mock("./api/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./api/auth.ts")>()
  const { useSyncExternalStore } = await import("react")
  return {
    ...real,
    authClient: {
      useSession: () => ({
        data: useSyncExternalStore(session.subscribe, session.get),
        isPending: session.get() === null,
      }),
      listSessions: auth.listSessions,
      revokeOtherSessions: auth.revokeOtherSessions,
      signOut: auth.signOut,
      signIn: { username: auth.signInUsername },
      signUp: { email: auth.signUpEmail },
      twoFactor: {
        verifyTotp: auth.verifyTotp,
        verifyBackupCode: auth.verifyBackupCode,
        generateBackupCodes: auth.generateBackupCodes,
        disable: auth.disable,
        enable: auth.enable,
      },
      admin: { listUsers: auth.listUsers },
    },
  }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const he = (key: string, vars?: Record<string, string | number>) => translate("he", key, vars)

type Answers = Record<
  string,
  TransportResponse | ((request: TransportRequest) => TransportResponse | Promise<TransportResponse>)
>

let requests: TransportRequest[] = []
let mounted: { root: Root; host: HTMLElement } | null = null
let router: ReturnType<typeof createMemoryRouter> | null = null

const ok = (body: unknown): TransportResponse => ({ status: 200, body })
const status = (over: Partial<{ hasUser: boolean; open: boolean }> = {}) =>
  ok({ hasUser: true, open: false, closesInSeconds: 0, defaultLocale: "he", ...over })
const signedOut: TransportResponse = { status: 401, body: { error: "unauthorized" } }
const totpRequired: TransportResponse = { status: 403, body: { error: "totp_required" } }
const admin = ok({ id: "u1", username: "first.admin", role: "admin" })
const agent = ok({ id: "u2", username: "agent.one", role: "agent" })
const noTickets = ok({ tickets: [], next: null, organizations: [], categories: [] })

async function renderAt(path: string, answers: Answers): Promise<void> {
  requests = []
  setTransport(async (request) => {
    requests.push(request)
    const path = request.url.split("?")[0] ?? ""
    // The home page is the ticket list: an empty one unless the test answers it.
    const answer = answers[path] ?? (path === "/api/v1/tickets" ? noTickets : undefined)
    if (!answer) return { status: 404, body: { error: "not_found" } }
    return typeof answer === "function" ? answer(request) : answer
  })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted = { root, host }
  router = createMemoryRouter(ROUTES, { initialEntries: [path] })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router as ReturnType<typeof createMemoryRouter>} />
        </QueryClientProvider>
      </I18nProvider>,
    )
  })
}

const where = () => `${router?.state.location.pathname}${router?.state.location.search}`
const text = () => document.body.textContent ?? ""

/** Types into a React-controlled field the way a browser does. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

beforeEach(() => {
  localStorage.clear()
  for (const fn of Object.values(auth)) fn.mockReset()
  pdf.loadPdfJs.mockReset()
  pdf.openPdf.mockReset()
  auth.listSessions.mockResolvedValue({ data: [], error: null })
  auth.signOut.mockResolvedValue({ data: {}, error: null })
  session.set({ session: { id: "current" }, user: { id: "u1", role: "admin" } })
})

afterEach(async () => {
  if (mounted) {
    const { root, host } = mounted
    await act(async () => root.unmount())
    host.remove()
  }
  mounted = null
  document.body.innerHTML = ""
})

describe("the session gate", () => {
  it("sends a signed-out visitor to sign-in, and back to the page afterwards", async () => {
    await renderAt("/users", { "/api/setup/status": status(), "/api/v1/me": signedOut })
    await vi.waitFor(() => expect(where()).toBe("/login?next=%2Fusers"))
    await vi.waitFor(() => expect(text()).toContain(he("login.description")))
  })

  it("sends a session without two-factor to the two-factor setup", async () => {
    await renderAt("/settings", { "/api/setup/status": status(), "/api/v1/me": totpRequired })
    await vi.waitFor(() => expect(where()).toBe("/enroll?next=%2Fsettings"))
    await vi.waitFor(() => expect(text()).toContain(he("enroll.required")))
  })

  it("shows an admin every page in the navigation and the empty ticket list", async () => {
    await renderAt("/", { "/api/setup/status": status(), "/api/v1/me": admin })
    await vi.waitFor(() => expect(text()).toContain(he("tickets.empty")))
    const nav = document.querySelector(".ui-sidenav")?.textContent ?? ""
    for (const id of ["home", "intake", "organizations", "users", "settings", "audit"])
      expect(nav).toContain(he(`nav.${id}`))
  })

  it("hides admin pages from an agent and locks them on a direct address, without reading them", async () => {
    // The session and Maane's API agree on who is signed in, as they do with one cookie.
    session.set({ session: { id: "current" }, user: { id: "u2", role: "agent" } })
    await renderAt("/users", { "/api/setup/status": status(), "/api/v1/me": agent })
    await vi.waitFor(() => expect(text()).toContain(he("adminOnly.title")))
    const nav = document.querySelector(".ui-sidenav")?.textContent ?? ""
    expect(nav).toContain(he("nav.home"))
    for (const id of ["intake", "organizations", "users", "settings", "audit"])
      expect(nav).not.toContain(he(`nav.${id}`))
    expect(auth.listUsers).not.toHaveBeenCalled()
  })

  it("stays on the two-factor setup after two-factor was turned off, despite the cached full session", async () => {
    const answers: Answers = { "/api/setup/status": status(), "/api/v1/me": admin }
    await renderAt("/account", answers)
    await vi.waitFor(() => expect(text()).toContain(he("account.sessions")))
    answers["/api/v1/me"] = totpRequired
    await act(async () => router?.navigate("/enroll?next=%2Faccount", { replace: true }))
    await vi.waitFor(() => expect(text()).toContain(he("enroll.required")))
    expect(where()).toBe("/enroll?next=%2Faccount")
  })

  it("goes to sign-in when Maane's API answers 401 while a page is open", async () => {
    await renderAt("/settings", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/settings": signedOut,
    })
    await vi.waitFor(() => expect(where()).toBe("/login?next=%2Fsettings"))
  })

  it("goes to sign-in when a Better Auth call answers 401 because the session is gone", async () => {
    const answers: Answers = { "/api/setup/status": status(), "/api/v1/me": admin }
    auth.listSessions.mockImplementation(async () => {
      answers["/api/v1/me"] = signedOut
      noteAuthStatus(401)
      return { data: null, error: { status: 401 } }
    })
    await renderAt("/account", answers)
    await vi.waitFor(() => expect(where()).toBe("/login?next=%2Faccount"))
  })

  it("stays on the page when a Better Auth call answers 401 but the session is still there", async () => {
    auth.listSessions.mockImplementation(async () => {
      noteAuthStatus(401)
      return { data: null, error: { status: 401, code: "INVALID_PASSWORD" } }
    })
    await renderAt("/account", { "/api/setup/status": status(), "/api/v1/me": admin })
    await vi.waitFor(() => expect(requests.filter((r) => r.url === "/api/v1/me").length).toBeGreaterThan(1))
    await vi.waitFor(() => expect(text()).toContain(he("account.failed")))
    expect(where()).toBe("/account")
  })

  it("follows the session to another user and drops what the previous one loaded", async () => {
    const answers: Answers = { "/api/setup/status": status(), "/api/v1/me": admin }
    await renderAt("/account", answers)
    await vi.waitFor(() => expect(text()).toContain("first.admin"))
    const reads = auth.listSessions.mock.calls.length
    answers["/api/v1/me"] = agent
    await act(async () => session.set({ session: { id: "other" }, user: { id: "u2", role: "agent" } }))
    await vi.waitFor(() => expect(text()).toContain("agent.one"))
    expect(text()).not.toContain("first.admin")
    expect(document.querySelector(".ui-sidenav")?.textContent ?? "").not.toContain(he("nav.users"))
    expect(auth.listSessions.mock.calls.length).toBeGreaterThan(reads)
  })

  it("follows a role change in the same session", async () => {
    const answers: Answers = { "/api/setup/status": status(), "/api/v1/me": admin }
    await renderAt("/", answers)
    await vi.waitFor(() => expect(document.querySelector(".ui-sidenav")?.textContent).toContain(he("nav.users")))
    answers["/api/v1/me"] = ok({ id: "u1", username: "first.admin", role: "agent" })
    await act(async () => session.set({ session: { id: "current" }, user: { id: "u1", role: "agent" } }))
    await vi.waitFor(() =>
      expect(document.querySelector(".ui-sidenav")?.textContent ?? "").not.toContain(he("nav.users")),
    )
  })
})

describe("account", () => {
  const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
  const closeX = () =>
    document.querySelector<HTMLButtonElement>(`[role=dialog] button[aria-label="${he("common.close")}"]`)

  // Built at run time: backup codes are secret-like values.
  let codes: string[] = []

  async function showNewCodes() {
    codes = Array.from({ length: 2 }, () => crypto.randomUUID().slice(0, 11))
    auth.generateBackupCodes.mockResolvedValue({ data: { backupCodes: codes }, error: null })
    await renderAt("/account", { "/api/setup/status": status(), "/api/v1/me": admin })
    await vi.waitFor(() => expect(button(he("account.newCodes"))).toBeDefined())
    await act(async () => button(he("account.newCodes"))?.click())
    const field = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>("[role=dialog] input")
      expect(input).not.toBeNull()
      return input as HTMLInputElement
    })
    await act(async () => type(field, crypto.randomUUID()))
    await act(async () => button(he("account.newCodesSubmit"))?.click())
    await vi.waitFor(() => expect(text()).toContain(codes[0] as string))
  }

  it("warns before new backup codes are closed unsaved, by the X and by Escape", async () => {
    await showNewCodes()
    await act(async () => closeX()?.click())
    await vi.waitFor(() => expect(text()).toContain(he("account.codesLossTitle")))
    await act(async () => button(he("account.codesLossBack"))?.click())
    await vi.waitFor(() => expect(text()).not.toContain(he("account.codesLossTitle")))
    expect(text()).toContain(codes[0] as string)

    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    await vi.waitFor(() => expect(text()).toContain(he("account.codesLossTitle")))
    await act(async () => button(he("account.codesLossClose"))?.click())
    await vi.waitFor(() => expect(text()).not.toContain(codes[0] as string))
  })

  it("closes at once once the codes are marked saved", async () => {
    await showNewCodes()
    await act(async () => document.querySelector<HTMLInputElement>("[role=dialog] input[type=checkbox]")?.click())
    await act(async () => closeX()?.click())
    await vi.waitFor(() => expect(text()).not.toContain(codes[0] as string))
    expect(text()).not.toContain(he("account.codesLossTitle"))
  })

  it("reads a session's device in the page's direction, so the Hebrew label keeps its order around English names", async () => {
    const at = new Date().toISOString()
    const linux =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36"
    auth.listSessions.mockResolvedValue({
      data: [{ id: "current", token: "t-current", createdAt: at, expiresAt: at, userAgent: linux }],
      error: null,
    })
    await renderAt("/account", { "/api/setup/status": status(), "/api/v1/me": admin })
    const name = he("account.browserOn", { browser: "Chrome", system: "Linux" })
    const label = await vi.waitFor(() => {
      const found = Array.from(document.querySelectorAll<HTMLElement>("#account-sessions .ui-item-title *")).find(
        (element) => element.textContent === name,
      )
      expect(found).toBeDefined()
      return found as HTMLElement
    })
    // Not dir="auto" (nor a bdi, which is auto without dir): the browser's name comes first and would turn it left to right.
    expect(label.tagName).not.toBe("BDI")
    expect(label.closest("[dir]")?.getAttribute("dir")).toBe("rtl")
  })
})

describe("setup", () => {
  it("offers the first admin while setup is open, and sign-in sends there while no user exists", async () => {
    await renderAt("/login", { "/api/setup/status": status({ hasUser: false, open: true }), "/api/v1/me": signedOut })
    await vi.waitFor(() => expect(where()).toBe("/setup"))
    await vi.waitFor(() => expect(text()).toContain(he("setup.create")))
  })

  it("says a restart opens setup when the window closed with no user", async () => {
    await renderAt("/setup", { "/api/setup/status": status({ hasUser: false, open: false }) })
    await vi.waitFor(() => expect(text()).toContain(he("setup.closedTitle")))
    expect(text()).toContain(he("setup.closedText", { minutes: 5 }))
    expect(document.querySelector("form")).toBeNull()
  })

  it("leaves for sign-in once a user exists", async () => {
    await renderAt("/setup", { "/api/setup/status": status(), "/api/v1/me": signedOut })
    await vi.waitFor(() => expect(where()).toBe("/login"))
  })

  it("creates the first admin with the four documented fields and the derived e-mail", async () => {
    auth.signUpEmail.mockResolvedValue({ data: null, error: { status: 403, code: "SETUP_CLOSED" } })
    await renderAt("/setup", { "/api/setup/status": status({ hasUser: false, open: true }) })
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull())
    const [username, password, repeat] = Array.from(document.querySelectorAll<HTMLInputElement>("form input"))
    const typed = crypto.randomUUID()
    await act(async () => {
      type(username as HTMLInputElement, "first.admin")
      type(password as HTMLInputElement, typed)
      type(repeat as HTMLInputElement, typed)
    })
    await act(async () => document.querySelector<HTMLButtonElement>("form button[type=submit]")?.click())
    await vi.waitFor(() =>
      expect(auth.signUpEmail).toHaveBeenCalledWith({
        name: "first.admin",
        email: "first.admin@maane.invalid",
        username: "first.admin",
        password: typed,
      }),
    )
  })
})

describe("sign-in", () => {
  it("asks for the second factor and never sends trustDevice", async () => {
    auth.signInUsername.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null })
    auth.verifyTotp.mockResolvedValue({ data: null, error: { status: 401, code: "INVALID_CODE" } })
    await renderAt("/login", { "/api/setup/status": status(), "/api/v1/me": signedOut })
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull())
    const [username, password] = Array.from(document.querySelectorAll<HTMLInputElement>("form input"))
    await act(async () => {
      type(username as HTMLInputElement, "first.admin")
      type(password as HTMLInputElement, crypto.randomUUID())
    })
    await act(async () => document.querySelector<HTMLButtonElement>("form button[type=submit]")?.click())
    await vi.waitFor(() => expect(text()).toContain(he("login.codeDescription")))
    const code = document.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]")
    await act(async () => type(code as HTMLInputElement, "123456"))
    await vi.waitFor(() => expect(auth.verifyTotp).toHaveBeenCalledWith({ code: "123456" }))
    await vi.waitFor(() => expect(text()).toContain(he("errors.code.wrongCode")))
  })

  it("explains a wrong password in words", async () => {
    auth.signInUsername.mockResolvedValue({ data: null, error: { status: 401, code: "INVALID_USERNAME_OR_PASSWORD" } })
    await renderAt("/login", { "/api/setup/status": status(), "/api/v1/me": signedOut })
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull())
    const [username, password] = Array.from(document.querySelectorAll<HTMLInputElement>("form input"))
    await act(async () => {
      type(username as HTMLInputElement, "first.admin")
      type(password as HTMLInputElement, crypto.randomUUID())
    })
    await act(async () => document.querySelector<HTMLButtonElement>("form button[type=submit]")?.click())
    await vi.waitFor(() => expect(text()).toContain(he("errors.code.wrongCredentials")))
  })

  it("goes straight on when the session is already full", async () => {
    await renderAt("/login?next=%2Faudit", { "/api/setup/status": status(), "/api/v1/me": admin })
    await vi.waitFor(() => expect(where()).toBe("/audit"))
  })
})

describe("settings", () => {
  const view = (key: string, value: unknown, locked = false) => ({
    key,
    value,
    secret: false,
    set: true,
    locked,
    variable: locked ? "MAANE_SESSION_DAYS" : null,
  })

  it("locks a value the environment sets, and resets a changed one to its default through the save bar", async () => {
    await renderAt("/settings", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/settings": ok({
        settings: [view("general.defaultLocale", "en"), view("security.sessionDays", 30, true)],
      }),
    })
    await vi.waitFor(() => expect(text()).toContain(he("settings.env.pill")))
    expect(text()).toContain("MAANE_SESSION_DAYS")
    expect(document.querySelector<HTMLInputElement>("input[type=number]")?.disabled).toBe(true)
    expect(text()).toContain(he("settings.changed"))

    const reset = Array.from(document.querySelectorAll("button")).find((b) => b.className.includes("is-reset"))
    await act(async () => reset?.click())
    await vi.waitFor(() => expect(document.querySelector(".ui-savebar")).not.toBeNull())
    expect(document.querySelector(".ui-savebar")?.textContent).toContain(he("savebar.save"))
    expect(document.querySelector("button[lang=he]")?.getAttribute("aria-pressed")).toBe("true")
  })

  it("isolates the bounce address example as one address, so it reads in order inside a Hebrew hint", async () => {
    await renderAt("/settings", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/settings": ok({ settings: [view("general.defaultLocale", "he"), view("mail.bounceAddress", "")] }),
    })
    await vi.waitFor(() => expect(text()).toContain(he("settings.sending.mail.bounceAddress.label")))
    // Not bounces@ before an isolated domain: the isolate is neutral to the text around it, so the domain went first.
    expect(text()).toContain(`${FSI}bounces@example.com${PDI}`)
  })

  it("keeps an edit made while the save is on its way", async () => {
    let release: (answer: TransportResponse) => void = () => {}
    const loaded = (days: number) =>
      ok({ settings: [view("general.defaultLocale", "he"), view("security.sessionDays", days)] })
    await renderAt("/settings", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/settings": (request) =>
        request.method === "PUT"
          ? (new Promise<TransportResponse>((resolve) => {
              release = resolve
            }) as unknown as TransportResponse)
          : loaded(30),
    })
    const days = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>("input[type=number]")
      expect(input).not.toBeNull()
      return input as HTMLInputElement
    })
    await act(async () => type(days, "14"))
    const save = document.querySelector<HTMLButtonElement>(".ui-savebar-save")
    await act(async () => save?.click())
    await vi.waitFor(() => expect(requests.some((r) => r.method === "PUT")).toBe(true))
    await act(async () => type(days, "21"))
    await act(async () => release(loaded(14)))
    await vi.waitFor(() => expect(text()).toContain(he("settings.saved")))
    expect(days.value).toBe("21")
    expect(document.querySelector(".ui-savebar")).not.toBeNull()
  })

  const filesViews = () =>
    ok({
      settings: [
        view("general.defaultLocale", "he"),
        view("security.sessionDays", 14),
        view("intake.mode", "listening"),
        view("scanner.address", "clamav:3310"),
        view("scanner.unavailablePolicy", "block"),
        view("files.maxBytes", 50 * 1024 * 1024),
        view("files.blockedTypes", ["exe", "js"]),
      ],
    })
  const checkedAt = "2026-11-12T08:00:00.000Z"
  const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
  /** Types into a React-controlled text area the way a browser does. */
  function typeArea(area: HTMLTextAreaElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, value)
    area.dispatchEvent(new Event("input", { bubbles: true }))
  }

  it("shows the scanner's self-test, and runs a connection test the worker answers", async () => {
    const id = "6f1c2f8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"
    await renderAt("/settings", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/settings": filesViews(),
      "/api/v1/settings/scanner": ok({
        status: {
          address: "clamav:3310",
          ok: false,
          failedCheck: "encrypted_pdf",
          version: "ClamAV 1.5.4/28181/Thu Nov 12 06:27:14 2026",
          checkedAt,
        },
      }),
      "/api/v1/settings/scanner/test": { status: 202, body: { id } },
      [`/api/v1/settings/scanner/test/${id}`]: ok({
        state: "done",
        result: {
          address: "clamav:3310",
          ok: true,
          failedCheck: null,
          version: "ClamAV 1.5.4/28182/Thu Nov 12 09:27:14 2026",
          checkedAt,
        },
      }),
    })
    await vi.waitFor(() => expect(text()).toContain(he("settings.scanner.check.encrypted_pdf")))
    expect(text()).toContain(he("settings.scanner.failed"))
    expect(text()).toContain(he("settings.scanner.version", { version: "1.5.4", signatures: "28181" }))
    expect(text()).not.toContain("Nov")
    expect(text()).toContain(he("settings.scannerPolicy.explain.allow"))
    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("exe, js")
    expect(document.querySelector<HTMLInputElement>('input[max="100"]')?.value).toBe("50")

    await act(async () => button(he("settings.scanner.test"))?.click())
    await vi.waitFor(() => expect(text()).toContain(he("settings.scanner.testPassed")), { timeout: 5_000 })
    expect(text()).toContain(he("settings.scanner.passed"))
    expect(text()).not.toContain(he("settings.scanner.check.encrypted_pdf"))
    expect(requests.filter((r) => r.method === "POST" && r.url.endsWith("/settings/scanner/test"))).toHaveLength(1)
  })

  it("checks the file fields before saving, and sends the size in bytes and the types as a list", async () => {
    await renderAt("/settings", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/settings": (request) => (request.method === "PUT" ? filesViews() : filesViews()),
      "/api/v1/settings/scanner": ok({ status: null }),
    })
    await vi.waitFor(() => expect(text()).toContain(he("settings.scanner.notChecked")))
    const address = document.querySelector<HTMLInputElement>(
      'input[data-setting="scanner.address"]',
    ) as HTMLInputElement
    await act(async () => type(address, "clamav"))
    // A new address is tested only once it is saved.
    expect(text()).toContain(he("settings.scanner.saveFirst"))
    expect(button(he("settings.scanner.test"))?.disabled).toBe(true)
    await act(async () => document.querySelector<HTMLButtonElement>(".ui-savebar-save")?.click())
    expect(text()).toContain(he("settings.invalid", { field: he("settings.scannerAddress.label") }))
    expect(document.activeElement).toBe(address)
    expect(requests.some((r) => r.method === "PUT")).toBe(false)

    await act(async () => type(address, "scanner.example.com:3310"))
    await act(async () => type(document.querySelector<HTMLInputElement>('input[max="100"]') as HTMLInputElement, "20"))
    await act(async () => typeArea(document.querySelector("textarea") as HTMLTextAreaElement, ".EXE,\njs  bat"))
    await act(async () => document.querySelector<HTMLButtonElement>('button[data-policy="allow"]')?.click())
    await act(async () => document.querySelector<HTMLButtonElement>(".ui-savebar-save")?.click())
    await vi.waitFor(() => expect(requests.some((r) => r.method === "PUT")).toBe(true))
    expect(JSON.parse(requests.find((r) => r.method === "PUT")?.body ?? "{}")).toEqual({
      "scanner.address": "scanner.example.com:3310",
      "scanner.unavailablePolicy": "allow",
      "files.maxBytes": 20 * 1024 * 1024,
      "files.blockedTypes": ["exe", "js", "bat"],
    })
  })

  it("keeps the client secret write only, locks a field the environment sets, and runs the Graph connection test", async () => {
    const id = "7a2d3f9e-1b2c-4d3e-9f0a-1b2c3d4e5f60"
    const graphViews = (secretSet: boolean) =>
      ok({
        settings: [
          view("graph.tenantId", "example.onmicrosoft.com", true),
          view("graph.clientId", ""),
          { key: "graph.clientSecret", value: null, secret: true, set: secretSet, locked: false, variable: null },
          view("graph.mailbox", "intake@example.com"),
        ],
      })
    let saved = false
    await renderAt("/settings", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/settings": (request) => {
        if (request.method === "PUT") saved = true
        return graphViews(saved)
      },
      "/api/v1/settings/scanner": ok({ status: null }),
      "/api/v1/settings/graph/test": { status: 202, body: { id } },
      [`/api/v1/settings/graph/test/${id}`]: ok({
        state: "done",
        result: {
          ok: false,
          problem: "access_denied",
          code: "ErrorAccessDenied",
          status: 403,
          mailbox: "intake@example.com",
          checkedAt,
        },
      }),
    })
    await vi.waitFor(() => expect(text()).toContain(he("settings.graphSecret.notSet")))
    const field = (key: string) => document.querySelector<HTMLInputElement>(`input[data-setting="${key}"]`)
    // The environment sets the tenant: locked, with its variable named.
    expect(field("graph.tenantId")?.disabled).toBe(true)
    expect(text()).toContain("MAANE_SESSION_DAYS")
    const secretField = field("graph.clientSecret") as HTMLInputElement
    expect(secretField.type).toBe("password")
    expect(secretField.value).toBe("")
    expect(text()).toContain(he("settings.graph.test.notTested"))

    // A new application ID and secret: the test waits until they are saved, and the secret goes out once.
    const secret = crypto.randomUUID()
    await act(async () => type(field("graph.clientId") as HTMLInputElement, "not an id"))
    expect(text()).toContain(he("settings.graph.test.saveFirst"))
    expect(button(he("settings.graph.test.button"))?.disabled).toBe(true)
    await act(async () => document.querySelector<HTMLButtonElement>(".ui-savebar-save")?.click())
    expect(text()).toContain(he("settings.invalid", { field: he("settings.graphClient.label") }))
    const client = crypto.randomUUID()
    await act(async () => type(field("graph.clientId") as HTMLInputElement, client))
    await act(async () => type(secretField, secret))
    await act(async () => document.querySelector<HTMLButtonElement>(".ui-savebar-save")?.click())
    await vi.waitFor(() => expect(text()).toContain(he("settings.graphSecret.set")))
    expect(JSON.parse(requests.find((r) => r.method === "PUT")?.body ?? "{}")).toEqual({
      "graph.clientId": client,
      "graph.clientSecret": secret,
    })
    expect(field("graph.clientSecret")?.value).toBe("")

    await act(async () => button(he("settings.graph.test.button"))?.click())
    await vi.waitFor(() => expect(text()).toContain(he("settings.graph.problem.access_denied")), { timeout: 5_000 })
    expect(text()).toContain(he("settings.graph.test.failed"))
    expect(text()).toContain("ErrorAccessDenied")
    expect(requests.filter((r) => r.method === "POST" && r.url.endsWith("/settings/graph/test"))).toHaveLength(1)
  })

  it("counts no change for the same list written another way", async () => {
    await renderAt("/settings", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/settings": filesViews(),
      "/api/v1/settings/scanner": ok({ status: null }),
    })
    const area = await vi.waitFor(() => {
      const found = document.querySelector<HTMLTextAreaElement>("textarea")
      expect(found).not.toBeNull()
      return found as HTMLTextAreaElement
    })
    await act(async () => typeArea(area, "EXE\n.js"))
    expect(document.querySelector(".ui-savebar")).toBeNull()
  })
})

describe("organizations", () => {
  const ORG = "0d7c6f0e-6a55-4b8e-9c55-5f0b6a3e2a11"
  const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
  const when = "2026-11-12T08:00:00.000Z"
  const detail = ok({
    organization: { id: ORG, name: "Example Support", createdAt: when },
    addresses: [
      { id: "a1", kind: "exact", value: "help@example.com", isDefault: true, createdAt: when },
      { id: "a2", kind: "pattern", value: "*@two.example.com", isDefault: false, createdAt: when },
    ],
    members: [{ userId: "u2", username: "agent.one", role: "agent", banned: false, createdAt: when }],
  })

  it("lists each organization with its counts and the default mark, and opens it from its row", async () => {
    await renderAt("/organizations", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/admin/organizations": ok({
        organizations: [
          { id: ORG, name: "Example Support", createdAt: when, addresses: 2, members: 1, hasDefault: true },
        ],
      }),
      [`/api/v1/admin/organizations/${ORG}`]: detail,
    })
    const row = await vi.waitFor(() => {
      const link = document.querySelector<HTMLAnchorElement>('a[data-organization="Example Support"]')
      expect(link).not.toBeNull()
      return link as HTMLAnchorElement
    })
    expect(row.textContent).toContain(translate("he", "organizations.addressCount.two", { count: "2" }))
    expect(row.textContent).toContain(he("organizations.holdsDefault"))
    await act(async () => row.click())
    await vi.waitFor(() => expect(where()).toBe(`/organizations/${ORG}`))
    await vi.waitFor(() => expect(document.querySelector('[data-address="help@example.com"]')).not.toBeNull())
  })

  it("answers the address check from the server, and refuses a value that is not an address before asking", async () => {
    await renderAt("/organizations", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/admin/organizations": ok({ organizations: [] }),
      "/api/v1/admin/organizations/address-check": ok({
        address: "billing@two.example.com",
        via: "pattern",
        organization: { id: ORG, name: "Example Support" },
        rule: { id: "a2", kind: "pattern", value: "*@two.example.com" },
      }),
    })
    await vi.waitFor(() => expect(text()).toContain(he("organizations.empty")))
    const field = document.querySelector<HTMLInputElement>(".ui-check-form input") as HTMLInputElement
    await act(async () => type(field, "not an address"))
    await act(async () => button(he("organizations.check.submit"))?.click())
    expect(text()).toContain(he("errors.code.addressInvalid", ERROR_VARS))
    expect(requests.some((r) => r.url.includes("address-check"))).toBe(false)

    await act(async () => type(field, "Billing@two.example.com"))
    await act(async () => button(he("organizations.check.submit"))?.click())
    await vi.waitFor(() => expect(text()).toContain("*@two.example.com"))
    const asked = requests.find((r) => r.url.includes("address-check"))
    expect(asked?.url).toBe("/api/v1/admin/organizations/address-check?address=Billing%40two.example.com")
    // The address shows isolated left to right inside the right-to-left page.
    expect(document.querySelector('.ui-banner bdi[dir="ltr"]')?.textContent).toBe("billing@two.example.com")
  })

  it("shows the addresses with their kind and the default mark, and the agents", async () => {
    await renderAt(`/organizations/${ORG}`, {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      [`/api/v1/admin/organizations/${ORG}`]: detail,
    })
    const exact = await vi.waitFor(() => {
      const row = document.querySelector('[data-address="help@example.com"]')
      expect(row).not.toBeNull()
      return row as HTMLElement
    })
    expect(exact.textContent).toContain(he("organization.kind.exact"))
    expect(exact.textContent).toContain(he("organization.addresses.default"))
    expect(exact.querySelector('bdi[dir="ltr"]')?.textContent).toBe("help@example.com")
    const pattern = document.querySelector('[data-address="*@two.example.com"]')
    expect(pattern?.textContent).toContain(he("organization.kind.pattern"))
    expect(pattern?.textContent).not.toContain(he("organization.addresses.default"))
    expect(document.querySelector('[data-member="agent.one"]')).not.toBeNull()
  })

  it("checks a new pattern's syntax before sending it, and sends a valid one in lower case", async () => {
    await renderAt(`/organizations/${ORG}`, {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      [`/api/v1/admin/organizations/${ORG}`]: detail,
      [`/api/v1/admin/organizations/${ORG}/addresses`]: { status: 201, body: { address: { id: "a3" } } },
    })
    await vi.waitFor(() => expect(button(he("organization.addresses.add"))).toBeDefined())
    await act(async () => button(he("organization.addresses.add"))?.click())
    const dialog = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[role=dialog]")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    const pattern = dialog.querySelector<HTMLInputElement>('input[value="pattern"]') as HTMLInputElement
    await act(async () => pattern.click())
    const value = dialog.querySelector<HTMLInputElement>('input[type="text"]') as HTMLInputElement
    await act(async () => type(value, "*@*.example.com"))
    const submit = () => document.querySelector<HTMLButtonElement>("[role=dialog] .ui-dialog-foot button[type=submit]")
    await act(async () => submit()?.click())
    expect(dialog.textContent).toContain(he("errors.code.patternInvalid", ERROR_VARS))
    expect(requests.some((r) => r.method === "POST")).toBe(false)

    await act(async () => type(value, "Support-*@Example.com"))
    await act(async () => submit()?.click())
    await vi.waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true))
    const sent = requests.find((r) => r.method === "POST")
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({ kind: "pattern", value: "support-*@example.com" })
  })

  it("explains both intake modes in Settings, and points a refused switch to live at its field", async () => {
    const view = (key: string, value: unknown) => ({
      key,
      value,
      secret: false,
      set: true,
      locked: false,
      variable: null,
    })
    await renderAt("/settings", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/settings": (request) =>
        request.method === "PUT"
          ? { status: 409, body: { error: "intake_no_default_address", key: "intake.mode" } }
          : ok({
              settings: [
                view("general.defaultLocale", "he"),
                view("security.sessionDays", 14),
                view("intake.mode", "listening"),
              ],
            }),
    })
    await vi.waitFor(() => expect(text()).toContain(he("settings.intakeMode.explain.listening")))
    expect(text()).toContain(he("settings.intakeMode.explain.live"))
    expect(document.querySelector('button[data-mode="listening"]')?.getAttribute("aria-pressed")).toBe("true")
    await act(async () => document.querySelector<HTMLButtonElement>('button[data-mode="live"]')?.click())
    await act(async () => document.querySelector<HTMLButtonElement>(".ui-savebar-save")?.click())
    await vi.waitFor(() =>
      expect(text()).toContain(
        he("settings.refusedField", {
          field: he("settings.intakeMode.label"),
          reason: he("errors.code.intakeNoDefaultAddress"),
        }),
      ),
    )
    expect(JSON.parse(requests.find((r) => r.method === "PUT")?.body ?? "{}")).toEqual({ "intake.mode": "live" })
  })

  it("makes SMTP2GO's webhook address and token, shows them once, and asks before replacing them", async () => {
    let made = false
    const secret = (key: string) => ({ key, value: null, secret: true, set: made, locked: false, variable: null })
    // Built at run time: no secret-shaped literal in a tracked file.
    const url = `http://127.0.0.1:8090/hooks/smtp2go/${"p".repeat(43)}`
    const token = "t".repeat(43)
    await renderAt("/settings", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/settings": () => ok({ settings: [secret("smtp2go.webhookPath"), secret("smtp2go.webhookToken")] }),
      "/api/v1/settings/smtp2go/webhook": () => {
        made = true
        return ok({ url, token })
      },
    })
    const row = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-webhook]")
      expect(found?.getAttribute("data-webhook")).toBe("not-set")
      return found as HTMLElement
    })
    expect(row.textContent).toContain(he("settings.sending.webhook.notSet"))
    const make = () =>
      Array.from(document.querySelectorAll("button")).find((b) =>
        [he("settings.sending.webhook.generate"), he("settings.sending.webhook.replace")].includes(
          b.textContent?.trim() ?? "",
        ),
      )
    // The first ones are made at once: there is nothing to replace.
    await act(async () => make()?.click())
    await vi.waitFor(() => expect(document.querySelector("[data-webhook-url] bdi")?.textContent).toBe(url))
    expect(document.querySelector("[data-webhook-token] bdi")?.textContent).toBe(token)
    expect(document.querySelector("[data-webhook-url] bdi")?.getAttribute("dir")).toBe("ltr")
    expect(text()).toContain(he("settings.sending.webhook.shownOnce"))
    expect(requests.filter((r) => r.url === "/api/v1/settings/smtp2go/webhook")).toHaveLength(1)
    // New ones only after asking: the old ones stop working at once.
    await act(async () => make()?.click())
    await vi.waitFor(() => expect(document.querySelector("[role=alertdialog]")).not.toBeNull())
    expect(document.querySelector("[role=alertdialog]")?.textContent).toContain(
      he("settings.sending.webhook.replaceMessage"),
    )
    expect(requests.filter((r) => r.url === "/api/v1/settings/smtp2go/webhook")).toHaveLength(1)
    await act(async () => document.querySelector<HTMLButtonElement>("[role=alertdialog] .ui-btn-primary")?.click())
    await vi.waitFor(() => expect(requests.filter((r) => r.url === "/api/v1/settings/smtp2go/webhook")).toHaveLength(2))
  })
})

describe("organization dialogs", () => {
  const ORG = "0d7c6f0e-6a55-4b8e-9c55-5f0b6a3e2a11"
  const when = "2026-11-12T08:00:00.000Z"
  const detail = ok({
    organization: { id: ORG, name: "Example Support", createdAt: when },
    addresses: [],
    members: [{ userId: "u2", username: "agent.one", role: "agent", banned: false, createdAt: when }],
  })
  const button = (label: string, within: ParentNode = document) =>
    Array.from(within.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
  const agent = (id: string, username: string) => ({ id, username, name: username, role: "agent", createdAt: when })
  /** A request that answers only when the test says so. */
  function held() {
    let release: (answer: TransportResponse) => void = () => {}
    const answer = new Promise<TransportResponse>((resolve) => {
      release = resolve
    })
    return { answer: answer as unknown as TransportResponse, release: (a: TransportResponse) => release(a) }
  }
  /** Closes the open dialog by its X and confirms dropping what was typed. */
  async function closeTyped() {
    await act(async () =>
      document.querySelector<HTMLButtonElement>(`[role=dialog] button[aria-label="${he("common.close")}"]`)?.click(),
    )
    const question = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="alertdialog"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    await act(async () => button(he("unsaved.discard"), question)?.click())
    await vi.waitFor(() => expect(dialog()).toBeNull())
  }

  it("finds any agent through the admin plugin's search, and says when the list is cut short", async () => {
    auth.listUsers.mockImplementation(async ({ query }: { query: Record<string, unknown> }) => ({
      data:
        query.searchValue === "dana"
          ? { users: [agent("u9", "dana.levi")], total: 1 }
          : {
              users: [agent("u2", "agent.one"), ...Array.from({ length: 49 }, (_, i) => agent(`a${i}`, `agent${i}`))],
              total: 120,
            },
      error: null,
    }))
    await renderAt(`/organizations/${ORG}`, {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      [`/api/v1/admin/organizations/${ORG}`]: detail,
    })
    await vi.waitFor(() => expect(button(he("organization.members.add"))).toBeDefined())
    await act(async () => button(he("organization.members.add"))?.click())
    await vi.waitFor(() => expect(document.querySelector('[data-testid="agents-more"]')).not.toBeNull())
    expect(auth.listUsers.mock.calls[0]?.[0]).toEqual({
      query: {
        limit: 50,
        offset: 0,
        sortBy: "name",
        sortDirection: "asc",
        filterField: "role",
        filterValue: "agent",
        filterOperator: "eq",
      },
    })
    // The agent already in the organization is not offered.
    expect(dialog()?.querySelector('input[type="radio"][value="u2"]')).toBeNull()
    expect(dialog()?.querySelectorAll('input[type="radio"]')).toHaveLength(49)

    const search = dialog()?.querySelector<HTMLInputElement>('input[type="search"]') as HTMLInputElement
    await act(async () => type(search, "Dana"))
    await vi.waitFor(() => expect(dialog()?.querySelector('input[type="radio"][value="u9"]')).not.toBeNull())
    expect(auth.listUsers.mock.calls.at(-1)?.[0]).toMatchObject({
      query: { searchValue: "dana", searchField: "name", searchOperator: "contains", filterValue: "agent" },
    })
    expect(document.querySelector('[data-testid="agents-more"]')).toBeNull()
  })

  it("reaches an agent that 50 others sort before, by loading the next page", async () => {
    // "sam" sorts after a000.sam to a049.sam: the first page of a search for "sam" never holds it.
    const everyone = [
      ...Array.from({ length: 50 }, (_, i) => agent(`p${i}`, `a${String(i).padStart(3, "0")}.sam`)),
      agent("u7", "sam"),
      // Not a match: the empty search counts one more than the search for "sam", so the test can tell them apart.
      agent("u8", "zed"),
    ]
    auth.listUsers.mockImplementation(async ({ query }: { query: Record<string, unknown> }) => {
      const search = typeof query.searchValue === "string" ? query.searchValue : ""
      const matching = everyone.filter((user) => user.name.includes(search))
      const offset = Number(query.offset ?? 0)
      const limit = Number(query.limit)
      return { data: { users: matching.slice(offset, offset + limit), total: matching.length }, error: null }
    })
    await renderAt(`/organizations/${ORG}`, {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      [`/api/v1/admin/organizations/${ORG}`]: detail,
    })
    await vi.waitFor(() => expect(button(he("organization.members.add"))).toBeDefined())
    await act(async () => button(he("organization.members.add"))?.click())
    const search = await vi.waitFor(() => {
      const found = dialog()?.querySelector<HTMLInputElement>('input[type="search"]')
      expect(found).toBeTruthy()
      return found as HTMLInputElement
    })
    await act(async () => type(search, "sam"))
    await vi.waitFor(() =>
      expect(auth.listUsers.mock.calls.at(-1)?.[0]).toMatchObject({ query: { searchValue: "sam", offset: 0 } }),
    )
    // The answer for "sam" is on screen (51 found, not the 52 of the empty search) and the button can load more.
    await vi.waitFor(() => {
      expect(dialog()?.querySelector('[data-testid="agents-more"]')?.textContent).toBe(
        he("organization.members.more", { shown: 50, total: 51 }),
      )
      expect(button(he("organization.members.showMore"), dialog() as HTMLElement)?.disabled).toBe(false)
    })
    expect(dialog()?.querySelectorAll('input[type="radio"]')).toHaveLength(50)
    expect(dialog()?.querySelector('input[type="radio"][value="u7"]')).toBeNull()

    await act(async () => button(he("organization.members.showMore"), dialog() as HTMLElement)?.click())
    await vi.waitFor(() => expect(dialog()?.querySelector('input[type="radio"][value="u7"]')).not.toBeNull())
    expect(auth.listUsers.mock.calls.at(-1)?.[0]).toMatchObject({ query: { searchValue: "sam", offset: 50 } })
    // What was loaded stays, and nothing more is offered.
    expect(dialog()?.querySelectorAll('input[type="radio"]')).toHaveLength(51)
    expect(button(he("organization.members.showMore"), dialog() as HTMLElement)).toBeUndefined()
  })

  it("shows each line of the signature with its own direction, so an English line after a Hebrew one reads left to right", async () => {
    const SHALOM = String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd)
    await renderAt(`/organizations/${ORG}`, {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      [`/api/v1/admin/organizations/${ORG}`]: ok({
        organization: {
          id: ORG,
          name: "Example Support",
          signature: `${SHALOM},\nThe support team.`,
          reminderTemplate: "",
          reminderDays: 3,
          createdAt: when,
        },
        addresses: [],
        members: [],
      }),
    })
    const lines = await vi.waitFor(() => {
      const found = document.querySelectorAll<HTMLElement>('[data-testid="organization-signature"] [dir]')
      expect(found.length).toBe(2)
      return Array.from(found)
    })
    expect(lines.map((line) => [line.getAttribute("dir"), line.textContent])).toEqual([
      ["auto", `${SHALOM},`],
      ["auto", "The support team."],
    ])
  })

  it("shows the automatic reminder and edits its text and days, checking the days first (plan 4.3)", async () => {
    const SHALOM = String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd)
    const set = ok({
      organization: {
        id: ORG,
        name: "Example Support",
        signature: "",
        reminderTemplate: "",
        reminderDays: 3,
        createdAt: when,
      },
      addresses: [],
      members: [],
    })
    await renderAt(`/organizations/${ORG}`, {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      [`/api/v1/admin/organizations/${ORG}`]: set,
      [`/api/v1/admin/organizations/${ORG}/reminder`]: ok({ ok: true }),
    })
    const panel = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-testid="organization-reminder"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    // No template: no reminders for this organization.
    expect(panel.textContent).toContain(he("organization.reminder.empty"))
    await act(async () => button(he("organization.reminder.edit"), panel)?.click())
    const form = await vi.waitFor(() => {
      const found = dialog()
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    const area = form.querySelector("textarea") as HTMLTextAreaElement
    const days = form.querySelector<HTMLInputElement>('input[data-field="days"]') as HTMLInputElement
    expect(days.value).toBe("3")
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      setter?.call(area, `${SHALOM},\nOrder 1234`)
      area.dispatchEvent(new Event("input", { bubbles: true }))
      type(days, "0")
    })
    await act(async () => button(he("organization.reminder.save"))?.click())
    // Days outside their bounds are refused before anything is sent.
    expect(form.textContent).toContain(he("organization.reminder.daysRule", { min: 1, max: 60 }))
    expect(requests.some((r) => r.url.endsWith("/reminder"))).toBe(false)
    await act(async () => type(days, "5"))
    await act(async () => button(he("organization.reminder.save"))?.click())
    const put = await vi.waitFor(() => {
      const found = requests.find((r) => r.method === "PUT" && r.url === `/api/v1/admin/organizations/${ORG}/reminder`)
      expect(found).toBeDefined()
      return JSON.parse(found?.body ?? "null")
    })
    expect(put).toEqual({ template: `${SHALOM},\nOrder 1234`, days: 5 })
    await vi.waitFor(() => expect(dialog()).toBeNull())
  })

  it("stays on another organization when the answer to deleting the previous one arrives late", async () => {
    const OTHER = "6f1e2d3c-4b5a-4968-8776-655443322110"
    const empty = (id: string, name: string) =>
      ok({ organization: { id, name, createdAt: when }, addresses: [], members: [] })
    const pending = held()
    await renderAt(`/organizations/${ORG}`, {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/admin/organizations": ok({ organizations: [] }),
      [`/api/v1/admin/organizations/${ORG}`]: (request) =>
        request.method === "DELETE" ? pending.answer : empty(ORG, "First"),
      [`/api/v1/admin/organizations/${OTHER}`]: empty(OTHER, "Second"),
    })
    await vi.waitFor(() => expect(button(he("organization.delete"))).toBeDefined())
    await act(async () => button(he("organization.delete"))?.click())
    const question = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="alertdialog"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    await act(async () => button(he("organization.delete"), question)?.click())
    await vi.waitFor(() => expect(requests.some((r) => r.method === "DELETE")).toBe(true))

    // Straight from one organization to another, as Back or Forward does: the same route, another id.
    await act(async () => router?.navigate(`/organizations/${OTHER}`))
    await vi.waitFor(() => expect(text()).toContain("Second"))
    await act(async () => pending.release(ok({ ok: true })))
    await vi.waitFor(() => expect(text()).toContain(he("organization.deleteDone", { name: "First" })))
    expect(where()).toBe(`/organizations/${OTHER}`)
  })

  it("keeps a newly opened address dialog open when the answer to a closed one arrives late", async () => {
    const pending = held()
    await renderAt(`/organizations/${ORG}`, {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      [`/api/v1/admin/organizations/${ORG}`]: detail,
      [`/api/v1/admin/organizations/${ORG}/addresses`]: () => pending.answer,
    })
    await vi.waitFor(() => expect(button(he("organization.addresses.add"))).toBeDefined())
    await act(async () => button(he("organization.addresses.add"))?.click())
    const first = dialog()?.querySelector<HTMLInputElement>('input[type="text"]') as HTMLInputElement
    await act(async () => type(first, "help2@example.com"))
    await act(async () => document.querySelector<HTMLButtonElement>("[role=dialog] .ui-dialog-foot button")?.click())
    await vi.waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true))
    await closeTyped()

    await act(async () => button(he("organization.addresses.add"))?.click())
    const second = dialog()?.querySelector<HTMLInputElement>('input[type="text"]') as HTMLInputElement
    await act(async () => type(second, "typed@example.com"))
    await act(async () => pending.release({ status: 201, body: { address: { id: "a9" } } }))
    await vi.waitFor(() =>
      expect(text()).toContain(he("organization.addresses.addDone", { value: "help2@example.com" })),
    )
    expect(dialog()).not.toBeNull()
    expect(dialog()?.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe("typed@example.com")
  })

  it("neither closes a new create dialog nor navigates when the answer to a closed one arrives late", async () => {
    const pending = held()
    await renderAt("/organizations", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/admin/organizations": (request) =>
        request.method === "POST" ? pending.answer : ok({ organizations: [] }),
    })
    await vi.waitFor(() => expect(button(he("organizations.create"))).toBeDefined())
    await act(async () => button(he("organizations.create"))?.click())
    const first = dialog()?.querySelector<HTMLInputElement>("input") as HTMLInputElement
    await act(async () => type(first, "First try"))
    await act(async () => document.querySelector<HTMLButtonElement>("[role=dialog] .ui-dialog-foot button")?.click())
    await vi.waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true))
    await closeTyped()

    await act(async () => button(he("organizations.create"))?.click())
    const second = dialog()?.querySelector<HTMLInputElement>("input") as HTMLInputElement
    await act(async () => type(second, "Second try"))
    await act(async () => pending.release({ status: 201, body: { organization: { id: ORG, name: "First try" } } }))
    await vi.waitFor(() => expect(text()).toContain(he("organizations.createDone", { name: "First try" })))
    expect(where()).toBe("/organizations")
    expect(dialog()?.querySelector<HTMLInputElement>("input")?.value).toBe("Second try")
  })
})

describe("Maane's API requests", () => {
  it("sends the request header on every change, never on a read", async () => {
    await renderAt("/settings", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/settings": ok({ settings: [] }),
    })
    await vi.waitFor(() => expect(requests.some((r) => r.url === "/api/v1/settings")).toBe(true))
    for (const request of requests) expect(request.headers["x-maane-request"]).toBeUndefined()
    const { request } = await import("./api/client.ts")
    await request("PUT", "/settings", { "security.sessionDays": 7 })
    const put = requests.find((r) => r.method === "PUT")
    expect(put?.headers["x-maane-request"]).toBe("1")
    expect(put?.url).toBe("/api/v1/settings")
  })
})
describe("identity changes while a page is open", () => {
  it("goes to enrollment when another tab turned two-factor off", async () => {
    const answers: Answers = { "/api/setup/status": status(), "/api/v1/me": admin }
    session.set({ session: { id: "current" }, user: { id: "u1", role: "admin", twoFactorEnabled: true } } as never)
    await renderAt("/account", answers)
    await vi.waitFor(() => expect(text()).toContain("first.admin"))
    answers["/api/v1/me"] = totpRequired
    await act(async () =>
      session.set({ session: { id: "current" }, user: { id: "u1", role: "admin", twoFactorEnabled: false } } as never),
    )
    await vi.waitFor(() => expect(where()).toBe("/enroll?next=%2Faccount"))
  })
  it("drops a previous admin's settings draft even when me answers quickly", async () => {
    const view = (key: string, value: unknown) => ({ key, value, locked: false, variable: null })
    const answers: Answers = {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/settings": ok({ settings: [view("general.defaultLocale", "he"), view("security.sessionDays", 30)] }),
    }
    await renderAt("/settings", answers)
    const days = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>("input[type=number]")
      expect(input).not.toBeNull()
      return input as HTMLInputElement
    })
    await act(async () => type(days, "14"))
    answers["/api/v1/me"] = ok({ id: "u2", username: "second.admin", role: "admin" })
    await act(async () => session.set({ session: { id: "other" }, user: { id: "u2", role: "admin" } }))
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>("input[type=number]")?.value).toBe("30"))
    expect(document.querySelector(".ui-savebar")).toBeNull()
  })
  it("hides previous user's one-time backup codes on a fast identity switch", async () => {
    const codes = Array.from({ length: 2 }, () => crypto.randomUUID().slice(0, 11))
    auth.generateBackupCodes.mockResolvedValue({ data: { backupCodes: codes }, error: null })
    const answers: Answers = { "/api/setup/status": status(), "/api/v1/me": admin }
    await renderAt("/account", answers)
    const button = (label: string) =>
      Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
    await vi.waitFor(() => expect(button(he("account.newCodes"))).toBeDefined())
    await act(async () => button(he("account.newCodes"))?.click())
    const field = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>("[role=dialog] input")
      expect(input).not.toBeNull()
      return input as HTMLInputElement
    })
    await act(async () => type(field, crypto.randomUUID()))
    await act(async () => button(he("account.newCodesSubmit"))?.click())
    await vi.waitFor(() => expect(text()).toContain(codes[0] as string))
    answers["/api/v1/me"] = agent
    await act(async () => session.set({ session: { id: "other" }, user: { id: "u2", role: "agent" } }))
    await vi.waitFor(() => expect(text()).toContain("agent.one"))
    expect(text()).not.toContain(codes[0] as string)
  })

  it("cancels a question the previous identity opened, so its action never runs", async () => {
    const at = new Date().toISOString()
    const signedIn = (id: string) => ({ id, token: `t-${id}`, createdAt: at, expiresAt: at, userAgent: null })
    auth.listSessions.mockResolvedValue({ data: [signedIn("current"), signedIn("elsewhere")], error: null })
    auth.revokeOtherSessions.mockResolvedValue({ data: { status: true }, error: null })
    session.set({ session: { id: "current" }, user: { id: "u1", role: "admin" } })
    const answers: Answers = { "/api/setup/status": status(), "/api/v1/me": admin }
    await renderAt("/account", answers)
    const button = (label: string) =>
      Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
    await vi.waitFor(() => expect(button(he("account.endOthers"))).toBeDefined())
    await act(async () => button(he("account.endOthers"))?.click())
    await vi.waitFor(() => expect(document.querySelector("[role=alertdialog]")).not.toBeNull())
    answers["/api/v1/me"] = agent
    await act(async () => session.set({ session: { id: "other" }, user: { id: "u2", role: "agent" } }))
    await vi.waitFor(() => expect(text()).toContain("agent.one"))
    expect(document.querySelector("[role=alertdialog]")).toBeNull()
    expect(auth.revokeOtherSessions).not.toHaveBeenCalled()
  })
})

describe("questions open while the session changes", () => {
  const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)

  it("dismisses the pending destructive question before sign-in on 401", async () => {
    const at = new Date().toISOString()
    auth.listSessions.mockResolvedValue({
      data: ["current", "other"].map((id) => ({ id, token: id, createdAt: at, expiresAt: at })),
      error: null,
    })
    const answers: Answers = {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/review-expiry": signedOut,
    }
    await renderAt("/account", answers)
    await vi.waitFor(() => expect(button(he("account.endOthers"))).toBeDefined())
    await act(async () => button(he("account.endOthers"))?.click())
    await vi.waitFor(() => expect(document.querySelector("[role=alertdialog]")).not.toBeNull())
    answers["/api/v1/me"] = signedOut
    const { request } = await import("./api/client.ts")
    await act(async () => {
      await request("GET", "/review-expiry").catch(() => {})
    })
    await vi.waitFor(() => expect(where()).toBe("/login?next=%2Faccount"))
    expect(document.querySelector("[role=alertdialog]")).toBeNull()
    expect(auth.revokeOtherSessions).not.toHaveBeenCalled()
  })

  it("cancels the discard question without closing anything belonging to the next identity", async () => {
    const answers: Answers = { "/api/setup/status": status(), "/api/v1/me": admin }
    await renderAt("/account", answers)
    await vi.waitFor(() => expect(button(he("account.change"))).toBeDefined())
    await act(async () => button(he("account.change"))?.click())
    await vi.waitFor(() => expect(document.querySelector("[role=dialog] input")).not.toBeNull())
    await act(async () => type(document.querySelector("[role=dialog] input") as HTMLInputElement, crypto.randomUUID()))
    await act(async () => document.querySelector<HTMLButtonElement>("[role=dialog] .ui-dialog-head button")?.click())
    await vi.waitFor(() => expect(document.querySelector("[role=alertdialog]")).not.toBeNull())
    answers["/api/v1/me"] = agent
    await act(async () => session.set({ session: { id: "other" }, user: { id: "u2", role: "agent" } }))
    await vi.waitFor(() => expect(text()).toContain("agent.one"))
    expect(document.querySelector("[role=alertdialog]")).toBeNull()
    expect(document.querySelector("[role=dialog]")).toBeNull()
    await act(async () => button(he("account.change"))?.click())
    await vi.waitFor(() => expect(document.querySelector("[role=dialog] input")).not.toBeNull())
    expect((document.querySelector("[role=dialog] input") as HTMLInputElement).value).toBe("")
  })
})

describe("a session that arrives after the page shows a user", () => {
  it("cancels an old question when the first Better Auth identity arrives after me", async () => {
    session.set(null)
    const at = new Date().toISOString()
    auth.listSessions.mockResolvedValue({
      data: ["current", "other"].map((id) => ({ id, token: id, createdAt: at, expiresAt: at })),
      error: null,
    })
    const answers: Answers = { "/api/setup/status": status(), "/api/v1/me": admin }
    await renderAt("/account", answers)
    const button = (label: string) =>
      Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
    await vi.waitFor(() => expect(button(he("account.endOthers"))).toBeDefined())
    await act(async () => button(he("account.endOthers"))?.click())
    await vi.waitFor(() => expect(document.querySelector("[role=alertdialog]")).not.toBeNull())
    answers["/api/v1/me"] = agent
    await act(async () => session.set({ session: { id: "other" }, user: { id: "u2", role: "agent" } }))
    auth.revokeOtherSessions.mockResolvedValue({ data: { status: true }, error: null })
    await act(async () => document.querySelector<HTMLButtonElement>("[role=alertdialog] .ui-btn-danger-solid")?.click())
    expect(auth.revokeOtherSessions).not.toHaveBeenCalled()
  })
})

describe("a session that answers behind Maane's API", () => {
  it("resets once for a role the session has not caught up with, not again and again", async () => {
    let meReads = 0
    const changed = ok({ id: "u1", username: "first.admin", role: "agent" })
    const answers: Answers = {
      "/api/setup/status": status(),
      "/api/v1/me": (() => {
        meReads++
        return new Promise((resolve) => setTimeout(() => resolve(changed), 20)) as unknown as TransportResponse
      }) as never,
    }
    await renderAt("/", answers)
    await vi.waitFor(() => expect(text()).toContain(he("tickets.empty")))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(meReads).toBeLessThanOrEqual(2)
  })
})

describe("turning two-factor off from a dialog that is gone", () => {
  it("does not start the setup when the answer arrives after the dialog was left", async () => {
    const password = crypto.randomUUID()
    let release: (value: unknown) => void = () => {}
    auth.disable.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    auth.enable.mockResolvedValue({ data: null, error: { status: 401 } })
    const answers: Answers = { "/api/setup/status": status(), "/api/v1/me": admin }
    const button = (label: string) =>
      Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
    await renderAt("/account", answers)
    await vi.waitFor(() => expect(button(he("account.newAuthenticator"))).toBeDefined())
    await act(async () => button(he("account.newAuthenticator"))?.click())
    const field = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>("[role=dialog] input")
      expect(input).not.toBeNull()
      return input as HTMLInputElement
    })
    await act(async () => type(field, password))
    await act(async () => button(he("account.newAuthenticatorSubmit"))?.click())
    await vi.waitFor(() => expect(auth.disable).toHaveBeenCalledWith({ password }))
    answers["/api/v1/me"] = signedOut
    await act(async () => {
      await router?.navigate("/login")
    })
    await vi.waitFor(() => expect(text()).toContain(he("login.description")))
    expect(document.querySelector("[role=dialog]")).toBeNull()
    // Another user signs in elsewhere and needs the setup; the old dialog's answer arrives only now.
    answers["/api/v1/me"] = totpRequired
    await act(async () => session.set({ session: { id: "B" }, user: { id: "u2", role: "agent" } }))
    await act(async () => release({ data: { status: true }, error: null }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(auth.enable).not.toHaveBeenCalled()
    expect(where()).toBe("/login")
  })
})

describe("an identity that comes back, and a late settings answer", () => {
  const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)

  it("cancels a question when a previously handled pair returns after alignment", async () => {
    const at = new Date().toISOString()
    auth.listSessions.mockResolvedValue({
      data: ["current", "other"].map((id) => ({ id, token: id, createdAt: at, expiresAt: at })),
      error: null,
    })
    auth.revokeOtherSessions.mockResolvedValue({ data: { status: true }, error: null })
    const answers: Answers = { "/api/setup/status": status(), "/api/v1/me": agent }
    // The session remains A while /me first reads B; handle this disagreement once.
    await renderAt("/account", answers)
    await vi.waitFor(() => expect(text()).toContain("agent.one"))
    await new Promise((resolve) => setTimeout(resolve, 80))
    // /me catches up to A, while the session stays unchanged.
    answers["/api/v1/me"] = admin
    await act(async () => noteAuthStatus(401))
    await vi.waitFor(() => expect(text()).toContain("first.admin"))
    await vi.waitFor(() => expect(button(he("account.endOthers"))).toBeDefined())
    await act(async () => button(he("account.endOthers"))?.click())
    await vi.waitFor(() => expect(document.querySelector("[role=alertdialog]")).not.toBeNull())
    // Another tab has signed in as B again; /me notices before useSession refreshes.
    answers["/api/v1/me"] = agent
    await act(async () => noteAuthStatus(401))
    await vi.waitFor(() => expect(text()).toContain("agent.one"))
    await act(async () => document.querySelector<HTMLButtonElement>("[role=alertdialog] .ui-btn-danger-solid")?.click())
    expect(auth.revokeOtherSessions).not.toHaveBeenCalled()
  })

  it("does not overwrite B's settings read with A's late mutation answer", async () => {
    let release: (answer: TransportResponse) => void = () => {}
    const loaded = (days: number) =>
      ok({
        settings: [
          { key: "general.defaultLocale", value: "he", locked: false, variable: null },
          { key: "security.sessionDays", value: days, locked: false, variable: null },
        ],
      })
    let liveDays = 30
    const answers: Answers = {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/settings": (request) =>
        request.method === "PUT"
          ? (new Promise<TransportResponse>((resolve) => {
              release = resolve
            }) as unknown as TransportResponse)
          : loaded(liveDays),
    }
    await renderAt("/settings", answers)
    const days = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>("input[type=number]")
      expect(input).not.toBeNull()
      return input as HTMLInputElement
    })
    await act(async () => type(days, "14"))
    await act(async () => document.querySelector<HTMLButtonElement>(".ui-savebar-save")?.click())
    await vi.waitFor(() => expect(requests.some((r) => r.method === "PUT")).toBe(true))
    liveDays = 21
    answers["/api/v1/me"] = ok({ id: "u2", username: "second.admin", role: "admin" })
    await act(async () => session.set({ session: { id: "B" }, user: { id: "u2", role: "admin" } }))
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>("input[type=number]")?.value).toBe("21"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    await act(async () => {
      release(loaded(14))
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    expect(document.querySelector<HTMLInputElement>("input[type=number]")?.value).toBe("21")
  })
})
describe("identity switches that still reset", () => {
  it("still resets for session A, then B, then A after B caught up", async () => {
    let reads = 0
    const answers: Answers = {
      "/api/setup/status": status(),
      "/api/v1/me": () => {
        reads++
        return agent
      },
    }
    await renderAt("/account", answers)
    await vi.waitFor(() => expect(text()).toContain("agent.one"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    const first = reads
    await act(async () => session.set({ session: { id: "B" }, user: { id: "u2", role: "agent" } }))
    await vi.waitFor(() => expect(reads).toBeGreaterThan(first))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    const caughtUp = reads
    await act(async () => session.set({ session: { id: "A" }, user: { id: "u1", role: "admin" } }))
    await vi.waitFor(() => expect(reads).toBeGreaterThan(caughtUp))
    await vi.waitFor(() => expect(text()).toContain("agent.one"))
  })
})

describe("tickets", () => {
  const ORG_A = "0d7c6f0e-6a55-4b8e-9c55-5f0b6a3e2a11"
  const ORG_B = "1e8d7a1f-7b66-4c9f-8d66-6a1c7b4f3b22"
  const MESSAGE = "4b0f3c2d-1a2b-4c3d-8e4f-5a6b7c8d9e01"
  const CATEGORY = "2f9e8b2a-8c77-4da0-9e77-7b2d8c5a4c33"
  const CATEGORY_2 = "3a0f9c3b-9d88-4eb1-8f88-8c3e9d6b5d44"
  // Hebrew from code points: apps/web holds no Hebrew.
  const SHALOM = String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd)
  const when = "2026-11-12T08:00:00.000Z"
  const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
  const summary = (number: number, over: Record<string, unknown> = {}) => ({
    number,
    subject: `${SHALOM} ${number}`,
    status: "new",
    reviewFlags: [],
    organization: { id: ORG_A, name: "Alpha" },
    customer: { address: "dana@example.com", name: "Dana Customer" },
    messages: 1,
    createdAt: when,
    lastActivityAt: when,
    snoozedUntil: null,
    ...over,
  })
  const list = (tickets: unknown[]) =>
    ok({
      tickets,
      next: null,
      organizations: [
        { id: ORG_A, name: "Alpha" },
        { id: ORG_B, name: "Beta" },
      ],
      categories: [{ id: CATEGORY, name: "Billing" }],
    })
  const file = (over: Record<string, unknown>) => ({
    id: "f0",
    kind: "attachment",
    fileName: "file.bin",
    size: 2048,
    status: "clean",
    signature: null,
    blockedBy: null,
    unavailableReason: null,
    detectedType: null,
    preview: null,
    download: true,
    ...over,
  })
  const view = (
    version = "v1",
    replies: object[] = [],
    listening = false,
    ticketOver: Record<string, unknown> = {},
    moveTargets: { id: string; name: string }[] = [{ id: ORG_B, name: "Beta" }],
    scheduled: object[] = [],
    reminder: object | null = null,
  ) =>
    ok({
      ticket: {
        number: 7,
        referenceCode: "ABCD-EFGH",
        subject: `${SHALOM} subject`,
        status: "open",
        reviewFlags: ["sender_not_participant"],
        organization: { id: ORG_A, name: "Alpha" },
        supportAddress: "help@example.com",
        createdAt: when,
        lastActivityAt: when,
        categories: [{ id: CATEGORY, name: "Billing" }],
        snoozedUntil: null,
        snoozeOverdue: false,
        ...ticketOver,
      },
      participants: [{ address: "dana@example.com", name: "Dana Customer" }],
      links: [{ number: 3, reason: "sender_not_participant" }],
      messages: [
        {
          id: MESSAGE,
          direction: "in",
          author: null,
          delivery: null,
          receivedAt: when,
          sentAt: when,
          from: { address: "dana@example.com", name: "Dana Customer" },
          to: [{ address: "help@example.com", name: null }],
          cc: [],
          subject: "Hello",
          content: "parsed",
          reviewFlags: ["blocked_content"],
          body: "html",
          remoteImages: 2,
          bodyLines: 4,
          bodyVersion: version,
          fields: [{ field: "text", status: "infected", signature: "Eicar-Signature" }],
          attachments: [
            file({ id: "f1", fileName: "photo.png", detectedType: "image/png", preview: "image" }),
            file({
              id: "f2",
              fileName: "invoice.pdf",
              status: "infected",
              signature: "Win.Test.EICAR_HDB-1",
              download: false,
            }),
            file({ id: "f3", fileName: "drawing.svg", detectedType: "application/octet-stream" }),
            file({ id: "f4", fileName: "copy.pdf", detectedType: "application/pdf", preview: "pdf" }),
          ],
        },
        ...replies,
      ],
      compose: {
        from: ["help@example.com", "billing@example.com"],
        defaultFrom: "help@example.com",
        to: [{ address: "dana@example.com", name: "Dana Customer" }],
        cc: [{ address: "ron@example.com", name: null }],
        signature: `Alpha support\n${SHALOM},\nThe Alpha team.`,
        senderName: "Agent Name (Alpha)",
        listening,
      },
      categories: [
        { id: CATEGORY, name: "Billing" },
        { id: CATEGORY_2, name: "Shipping" },
      ],
      moveTargets,
      scheduled,
      reminder,
    })

  it("lists tickets across organizations, and keeps the filters in the address", async () => {
    await renderAt("/", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets": (request) =>
        request.url.includes("flagged=1")
          ? list([summary(5, { reviewFlags: ["possibly_automated"] })])
          : list([summary(9), summary(5, { reviewFlags: ["possibly_automated"] })]),
    })
    const row = await vi.waitFor(() => {
      const found = document.querySelector<HTMLAnchorElement>('a[data-number="9"]')
      expect(found).not.toBeNull()
      return found as HTMLAnchorElement
    })
    expect(row.getAttribute("href")).toBe("/tickets/9")
    expect(row.querySelector('bdi[dir="auto"]')?.textContent).toBe(`${SHALOM} 9`)
    expect(row.querySelector('bdi[dir="ltr"]')?.textContent).toBe("#9")
    expect(row.textContent).toContain("Dana Customer")
    expect(row.textContent).toContain("Alpha")
    expect(row.textContent).toContain(he("ticket.status.new"))
    const flagged = document.querySelector('a[data-number="5"]')
    expect(flagged?.getAttribute("data-tone")).toBe("warn")
    expect(flagged?.textContent).toContain(he("flag.possibly_automated"))

    await act(async () => button(he("tickets.needsReview"))?.click())
    await vi.waitFor(() => expect(where()).toBe("/?review=1"))
    await vi.waitFor(() => expect(document.querySelector('a[data-number="9"]')).toBeNull())
    expect(requests.some((r) => r.url === "/api/v1/tickets?flagged=1")).toBe(true)

    // The rows and the filters stay while the next answer is on its way (TB-5).
    const select = document.querySelector<HTMLSelectElement>('[data-testid="organization-filter"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    await act(async () => {
      select.value = ORG_B
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await vi.waitFor(() => expect(where()).toBe(`/?review=1&organization=${ORG_B}`))
    expect(requests.some((r) => r.url === `/api/v1/tickets?organization=${ORG_B}&flagged=1`)).toBe(true)
  })

  it("says when no ticket matches the filters, and clears them", async () => {
    await renderAt("/?review=1", {
      "/api/setup/status": status(),
      "/api/v1/me": agent,
      "/api/v1/tickets": list([]),
    })
    await vi.waitFor(() => expect(text()).toContain(he("tickets.emptyFiltered")))
    await act(async () => button(he("tickets.clearFilters"))?.click())
    await vi.waitFor(() => expect(where()).toBe("/"))
  })

  it("searches on Enter or its button, keeps the term in the address, and says when nothing matches (plan 4.4)", async () => {
    await renderAt("/", {
      "/api/setup/status": status(),
      "/api/v1/me": agent,
      "/api/v1/tickets": (request) => (request.url.includes("q=") ? list([]) : list([summary(9)])),
    })
    const box = await vi.waitFor(() => {
      const found = document.querySelector<HTMLInputElement>('[data-testid="ticket-search"]')
      expect(found).not.toBeNull()
      return found as HTMLInputElement
    })
    expect(box.type).toBe("search")
    expect(box.dir).toBe("auto")
    expect(box.maxLength).toBe(SEARCH_MAX_LENGTH)
    expect(box.closest("search")).not.toBeNull()
    // Typing alone asks nothing (SR-9); the button runs the search, trimmed.
    await act(async () => type(box, ` ${SHALOM} `))
    expect(requests.some((r) => r.url.includes("q="))).toBe(false)
    await act(async () => button(he("tickets.searchSubmit"))?.click())
    const encoded = new URLSearchParams({ q: SHALOM }).toString()
    await vi.waitFor(() => expect(where()).toBe(`/?${encoded}`))
    expect(requests.some((r) => r.url === `/api/v1/tickets?${encoded}`)).toBe(true)
    // Without a chosen status the search covers every status, and the filter shows it.
    const statusFilter = document.querySelector<HTMLSelectElement>('[data-testid="status-filter"]') as HTMLSelectElement
    await vi.waitFor(() => expect(statusFilter.value).toBe("all"))
    // Nothing found: the term and a hint, which no status limits.
    await vi.waitFor(() => expect(text()).toContain(he("tickets.searchEmptyHint")))
    expect(text()).toContain(SHALOM)
    expect(text()).not.toContain(he("tickets.searchEmptyStatusHint"))
    // A chosen status narrows the search, open work too, and the hint says so.
    await act(async () => {
      statusFilter.value = "open_work"
      statusFilter.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await vi.waitFor(() => expect(where()).toBe(`/?${encoded}&status=open_work`))
    expect(requests.some((r) => r.url === `/api/v1/tickets?status=open_work&${encoded}`)).toBe(true)
    await vi.waitFor(() => expect(text()).toContain(he("tickets.searchEmptyStatusHint")))
    // Emptying the box ends the search at once.
    await act(async () => type(box, ""))
    await vi.waitFor(() => expect(where()).toBe("/?status=open_work"))
    await vi.waitFor(() => expect(document.querySelector('a[data-number="9"]')).not.toBeNull())
  })

  it("starts the search box from the address, with the other filters", async () => {
    await renderAt("/?status=solved&q=%2312", {
      "/api/setup/status": status(),
      "/api/v1/me": agent,
      "/api/v1/tickets": list([summary(12)]),
    })
    const box = await vi.waitFor(() => {
      const found = document.querySelector<HTMLInputElement>('[data-testid="ticket-search"]')
      expect(found?.value).toBe("#12")
      return found as HTMLInputElement
    })
    expect(box).not.toBeNull()
    expect(requests.some((r) => r.url === "/api/v1/tickets?status=solved&q=%2312")).toBe(true)
  })

  it("shows open work by default and filters by status and category, kept in the address (plan 4.1)", async () => {
    await renderAt("/", {
      "/api/setup/status": status(),
      "/api/v1/me": agent,
      "/api/v1/tickets": list([summary(9)]),
    })
    const statusFilter = await vi.waitFor(() => {
      const found = document.querySelector<HTMLSelectElement>('[data-testid="status-filter"]')
      expect(found).not.toBeNull()
      return found as HTMLSelectElement
    })
    // No status in the address is open work, and the request names none: the server's default is the same.
    expect(statusFilter.value).toBe("open_work")
    expect(statusFilter.selectedOptions[0]?.textContent).toBe(he("tickets.statusFilter.open_work"))
    expect(requests.some((r) => r.url === "/api/v1/tickets")).toBe(true)
    await act(async () => {
      statusFilter.value = "all"
      statusFilter.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await vi.waitFor(() => expect(where()).toBe("/?status=all"))
    expect(requests.some((r) => r.url === "/api/v1/tickets?status=all")).toBe(true)
    // The empty list of a chosen status is a filtered one, which can be cleared back to open work.
    const category = document.querySelector<HTMLSelectElement>('[data-testid="category-filter"]') as HTMLSelectElement
    expect(Array.from(category.options).map((option) => option.textContent)).toEqual([
      he("tickets.allCategories"),
      "Billing",
    ])
    await act(async () => {
      category.value = CATEGORY
      category.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await vi.waitFor(() => expect(where()).toBe(`/?status=all&category=${CATEGORY}`))
    expect(requests.some((r) => r.url === `/api/v1/tickets?status=all&category=${CATEGORY}`)).toBe(true)
    await act(async () => {
      statusFilter.value = "open_work"
      statusFilter.dispatchEvent(new Event("change", { bubbles: true }))
    })
    // Open work chosen by hand stays chosen, so a search started now keeps it instead of covering every status.
    await vi.waitFor(() => expect(where()).toBe(`/?status=open_work&category=${CATEGORY}`))
    const box = document.querySelector<HTMLInputElement>('[data-testid="ticket-search"]') as HTMLInputElement
    await act(async () => type(box, "#9"))
    await act(async () => button(he("tickets.searchSubmit"))?.click())
    await vi.waitFor(() => expect(where()).toBe(`/?status=open_work&category=${CATEGORY}&q=%239`))
    expect(requests.some((r) => r.url === `/api/v1/tickets?status=open_work&category=${CATEGORY}&q=%239`)).toBe(true)
    expect(statusFilter.value).toBe("open_work")
  })

  it("shows an imported ticket read-only until go-live, with its From Zendesk block (plan 5.1)", async () => {
    const imported = {
      zendeskId: 7,
      readOnly: true,
      brand: "Example Store",
      tags: ["vip", "billing"],
      fields: [{ name: "Order number", value: "A-17" }],
      followers: [{ name: "Dana Agent", address: "dana.agent@example.com" }],
    }
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view("v1", [], true, { imported }),
    })
    await vi.waitFor(() => expect(text()).toContain(he("ticket.imported.readOnly")))
    // No control changes it: status, snooze, categories, move, and the composer are not offered.
    expect(document.querySelector('[data-testid="ticket-status"]')).toBeNull()
    expect(button(he("ticket.categories.edit"))).toBeUndefined()
    expect(button(he("ticket.move.open"))).toBeUndefined()
    expect(document.querySelector(".ui-composer")).toBeNull()
    expect(text()).toContain(he("ticket.imported.composerLocked"))
    const block = document.querySelector('[data-testid="ticket-zendesk"]')
    expect(block?.textContent).toContain(he("ticket.imported.zendeskNumber", { number: 7 }))
    expect(block?.textContent).toContain("Example Store")
    expect(block?.textContent).toContain("A-17")
    expect(block?.textContent).toContain("vip")
    expect(block?.textContent).toContain("Dana Agent")
  })

  it("sets the status, the categories, and the organization from the ticket view (plan 4.1)", async () => {
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view(),
      "/api/v1/tickets/7/status": ok({ ok: true }),
      "/api/v1/tickets/7/categories": ok({ ok: true }),
      "/api/v1/tickets/7/organization": ok({ ok: true }),
    })
    const select = await vi.waitFor(() => {
      const found = document.querySelector<HTMLSelectElement>('[data-testid="ticket-status"]')
      expect(found).not.toBeNull()
      return found as HTMLSelectElement
    })
    expect(select.value).toBe("open")
    // An admin may close: every status is offered as itself.
    expect(Array.from(select.options).map((option) => [option.value, option.disabled])).toEqual([
      ["new", false],
      ["open", false],
      ["pending", false],
      ["on_hold", false],
      ["solved", false],
      ["closed", false],
    ])
    await act(async () => {
      select.value = "pending"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await vi.waitFor(() => {
      const put = requests.find((r) => r.method === "PUT" && r.url === "/api/v1/tickets/7/status")
      expect(JSON.parse(put?.body ?? "null")).toEqual({ status: "pending" })
    })
    expect(document.querySelector('[data-testid="ticket-categories"]')?.textContent).toBe("Billing")

    await act(async () => button(he("ticket.categories.edit"))?.click())
    const dialog = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[role=dialog]")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    const boxes = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    expect(boxes.map((box) => box.checked)).toEqual([true, false])
    await act(async () => boxes[1]?.click())
    await act(async () => button(he("ticket.categories.save"))?.click())
    await vi.waitFor(() => {
      const put = requests.find((r) => r.method === "PUT" && r.url === "/api/v1/tickets/7/categories")
      expect(JSON.parse(put?.body ?? "null")).toEqual({ categories: [CATEGORY, CATEGORY_2] })
    })
    await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull())

    await act(async () => button(he("ticket.move.open"))?.click())
    await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).not.toBeNull())
    expect(text()).toContain(he("ticket.move.hint", { name: "Alpha" }))
    await act(async () => button(he("ticket.move.submit"))?.click())
    await vi.waitFor(() => {
      const put = requests.find((r) => r.method === "PUT" && r.url === "/api/v1/tickets/7/organization")
      expect(JSON.parse(put?.body ?? "null")).toEqual({ organizationId: ORG_B })
    })
  })

  it("locks closed for an agent: offered as admins only, and a closed ticket's status and pending reply locked", async () => {
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": agent,
      "/api/v1/tickets/7": view("v1", [], false, {}, []),
    })
    const select = await vi.waitFor(() => {
      const found = document.querySelector<HTMLSelectElement>('[data-testid="ticket-status"]')
      expect(found).not.toBeNull()
      return found as HTMLSelectElement
    })
    const closed = Array.from(select.options).find((option) => option.value === "closed")
    expect(closed?.disabled).toBe(true)
    expect(closed?.textContent).toBe(he("ticket.statusAdminOnly", { status: he("ticket.status.closed") }))
    expect(select.disabled).toBe(false)
    // No organization to move to: no Move button.
    expect(button(he("ticket.move.open"))).toBeUndefined()
    expect(document.querySelector('[data-testid="composer-send-only"]')).not.toBeNull()
    if (mounted) {
      const { root, host } = mounted
      await act(async () => root.unmount())
      host.remove()
      mounted = null
    }

    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": agent,
      "/api/v1/tickets/7": view("v1", [], false, { status: "closed" }, []),
    })
    await vi.waitFor(() => expect(text()).toContain(he("ticket.statusClosedHint")))
    expect(document.querySelector<HTMLSelectElement>('[data-testid="ticket-status"]')?.disabled).toBe(true)
    // On a closed ticket an agent only sends; the status stays closed.
    expect(document.querySelector('[data-testid="composer-send-only"]')).toBeNull()
    expect(document.querySelector('[data-testid="composer-send"]')?.textContent).toBe(he("compose.sendReply"))
  })

  it("sends a reply as Send and set pending by default; Send and a note leave the status (plan 4.1)", async () => {
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view(),
      "/api/v1/tickets/7/messages": { status: 201, body: { id: "00000000-0000-4000-8000-0000000000bb" } },
    })
    const primary = await vi.waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')
      expect(found).not.toBeNull()
      return found as HTMLButtonElement
    })
    expect(primary.textContent).toBe(he("compose.sendPending"))
    expect(document.querySelector('[data-testid="composer-send-only"]')?.textContent).toBe(he("compose.sendOnly"))
    // A file of the ticket makes the reply something to send without typing (the editor is TipTap's).
    const attach = () =>
      act(async () =>
        document.querySelector<HTMLInputElement>('.ui-composer-ticket-files input[type="checkbox"]')?.click(),
      )
    const sent = () =>
      requests
        .filter((r) => r.method === "POST" && r.url === "/api/v1/tickets/7/messages")
        .map((r) => JSON.parse(r.body ?? "null") as { kind: string; setPending: boolean })
    await attach()
    await act(async () => primary.click())
    await vi.waitFor(() => expect(sent()).toHaveLength(1))
    expect(sent()[0]).toMatchObject({ kind: "reply", setPending: true })
    await vi.waitFor(() => expect(text()).toContain(he("compose.replyQueuedPending")))
    await attach()
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="composer-send-only"]')?.click())
    await vi.waitFor(() => expect(sent()).toHaveLength(2))
    expect(sent()[1]).toMatchObject({ kind: "reply", setPending: false })
    await act(async () => document.querySelector<HTMLButtonElement>('.ui-composer button[data-kind="note"]')?.click())
    await attach()
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')?.click())
    await vi.waitFor(() => expect(sent()).toHaveLength(3))
    expect(sent()[2]).toMatchObject({ kind: "note", setPending: false })
  })

  it("switches the composer to the new organization's From after a move, keeping the draft (review S2)", async () => {
    let moved = false
    const after = ok({
      ...(view().body as Record<string, unknown>),
      ticket: { ...(view().body as { ticket: object }).ticket, organization: { id: ORG_B, name: "Beta" } },
      moveTargets: [{ id: ORG_A, name: "Alpha" }],
      compose: {
        // The new default is not the first address: a stale From would show the first and send the old one.
        from: ["zeta@example.com", "beta@example.com"],
        defaultFrom: "beta@example.com",
        to: [{ address: "dana@example.com", name: "Dana Customer" }],
        cc: [],
        signature: "Beta support",
        senderName: "Agent Name (Beta)",
        listening: false,
      },
    })
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": () => (moved ? after : view()),
      "/api/v1/tickets/7/organization": () => {
        moved = true
        return ok({ ok: true })
      },
      "/api/v1/tickets/7/messages": { status: 201, body: { id: "00000000-0000-4000-8000-0000000000bb" } },
    })
    const box = () =>
      document.querySelector<HTMLInputElement>('.ui-composer-ticket-files input[type="checkbox"]') ?? null
    await vi.waitFor(() => expect(box()).not.toBeNull())
    // The draft: a file of the ticket, picked before the move.
    await act(async () => box()?.click())
    expect(box()?.checked).toBe(true)
    await act(async () => button(he("ticket.move.open"))?.click())
    await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).not.toBeNull())
    await act(async () => button(he("ticket.move.submit"))?.click())
    await vi.waitFor(() => expect(text()).toContain("Agent Name (Beta)"))
    await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull())
    expect(box()?.checked).toBe(true)
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')?.click())
    const posted = await vi.waitFor(() => {
      const found = requests.find((r) => r.method === "POST" && r.url === "/api/v1/tickets/7/messages")
      expect(found).toBeDefined()
      return JSON.parse(found?.body ?? "null") as { from: string; parts: string[] }
    })
    expect(posted.from).toBe("beta@example.com")
    expect(posted.parts).toHaveLength(1)
  })

  it("schedules a reply for a date and time in Israel time with its status action; refuses an hour Israel skips (plan 4.2)", async () => {
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view(),
      "/api/v1/tickets/7/messages": { status: 201, body: { scheduled: "00000000-0000-4000-8000-0000000000cc" } },
    })
    const later = await vi.waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>('[data-testid="composer-later"]')
      expect(found).not.toBeNull()
      return found as HTMLButtonElement
    })
    expect(later.textContent).toBe(he("compose.sendLater"))
    // Nothing to send yet: the composer says so before asking for a time.
    await act(async () => later.click())
    expect(text()).toContain(he("compose.empty"))
    expect(document.querySelector('[data-testid="composer-when"]')).toBeNull()
    await act(async () =>
      document.querySelector<HTMLInputElement>('.ui-composer-ticket-files input[type="checkbox"]')?.click(),
    )
    await act(async () => later.click())
    const form = await vi.waitFor(() => {
      const found = document.querySelector<HTMLFormElement>('[data-testid="composer-when"]')
      expect(found).not.toBeNull()
      return found as HTMLFormElement
    })
    expect(form.textContent).toContain(he("when.zone"))
    const date = form.querySelector<HTMLInputElement>('input[type="date"]') as HTMLInputElement
    const time = form.querySelector<HTMLInputElement>('input[data-field="time"]') as HTMLInputElement
    const submit = () => document.querySelector<HTMLButtonElement>('[data-testid="composer-when-submit"]')?.click()
    // 27 March 2099: Israel's clock skips from 02:00 to 03:00.
    await act(async () => {
      type(date, "2099-03-27")
      type(time, "02:30")
    })
    await act(async () => submit())
    expect(text()).toContain(he("when.missingHour"))
    // "Send" leaves the status: the status action is chosen here and applies when the reply goes.
    await act(async () => form.querySelector<HTMLInputElement>('input[data-pending="false"]')?.click())
    await act(async () => {
      type(date, "2099-01-10")
      type(time, "09:30")
    })
    await act(async () => submit())
    const posted = await vi.waitFor(() => {
      const found = requests.find((r) => r.method === "POST" && r.url === "/api/v1/tickets/7/messages")
      expect(found).toBeDefined()
      return JSON.parse(found?.body ?? "null") as { kind: string; sendAt: string; setPending: boolean }
    })
    expect(posted).toMatchObject({ kind: "reply", sendAt: "2099-01-10T07:30:00.000Z", setPending: false })
    await vi.waitFor(() => expect(document.querySelector('[data-testid="composer-when"]')).toBeNull())
  })

  it("shows scheduled replies with their state; cancels one after asking, and changes one as a new version (plan 4.2)", async () => {
    const SCHEDULED = "00000000-0000-4000-8000-0000000000dd"
    const entry = (over: Record<string, unknown>) => ({
      id: SCHEDULED,
      version: 3,
      state: "scheduled",
      reason: null,
      sendAt: "2099-01-10T07:30:00.000Z",
      createdAt: when,
      updatedAt: when,
      author: { id: "u1", name: "Agent Name" },
      editable: true,
      from: "help@example.com",
      to: [{ address: "dana@example.com", name: "Dana Customer" }],
      cc: [],
      text: `${SHALOM}\nSecond line`,
      html: `<p>${SHALOM}</p>`,
      setPending: true,
      files: [],
      messageId: null,
      outboxState: null,
      ...over,
    })
    const scheduled = [
      entry({}),
      entry({ id: "00000000-0000-4000-8000-0000000000ee", state: "cancelled", reason: "customer_reply" }),
    ]
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view("v1", [], false, {}, [{ id: ORG_B, name: "Beta" }], scheduled),
      [`/api/v1/scheduled/${SCHEDULED}/cancel`]: ok({ ok: true }),
      [`/api/v1/scheduled/${SCHEDULED}`]: ok({ ok: true }),
    })
    const card = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-scheduled="${SCHEDULED}"]`)
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(card.textContent).toContain(he("scheduled.state.scheduled"))
    // 07:30 UTC on 10 January is 09:30 in Israel.
    expect(card.textContent).toContain("10/01/2099 09:30")
    expect(card.querySelector('p[dir="auto"]')?.textContent).toBe(SHALOM)
    expect(text()).toContain(he("scheduled.reason.customer_reply"))

    await act(async () => card.querySelector<HTMLButtonElement>('[data-testid="scheduled-cancel"]')?.click())
    const question = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[role=alertdialog]")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    const confirm = Array.from(question.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === he("scheduled.cancel"),
    )
    await act(async () => confirm?.click())
    await vi.waitFor(() =>
      expect(requests.some((r) => r.method === "POST" && r.url === `/api/v1/scheduled/${SCHEDULED}/cancel`)).toBe(true),
    )

    await act(async () => button(he("scheduled.change"))?.click())
    const composer = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>(`.ui-composer[data-editing="${SCHEDULED}"]`)
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(composer.textContent).toContain(he("compose.editingHint"))
    // While it is being changed the composer only saves it (with its time) or stops.
    expect(composer.querySelector('[data-testid="composer-send"]')).toBeNull()
    await act(async () => composer.querySelector<HTMLButtonElement>('[data-testid="composer-later"]')?.click())
    const form = await vi.waitFor(() => {
      const found = document.querySelector<HTMLFormElement>('[data-testid="composer-when"]')
      expect(found).not.toBeNull()
      return found as HTMLFormElement
    })
    expect(form.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe("2099-01-10")
    expect(form.querySelector<HTMLInputElement>('input[data-field="time"]')?.value).toBe("09:30")
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="composer-when-submit"]')?.click())
    const put = await vi.waitFor(() => {
      const found = requests.find((r) => r.method === "PUT" && r.url === `/api/v1/scheduled/${SCHEDULED}`)
      expect(found).toBeDefined()
      return JSON.parse(found?.body ?? "null") as Record<string, unknown>
    })
    expect(put).toMatchObject({ version: 3, sendAt: "2099-01-10T07:30:00.000Z", setPending: true })
    expect(put).not.toHaveProperty("submissionId")
  })

  it("keeps a change on the version it loaded and on its reply: never a newer version, never a new reply (review T3, T4)", async () => {
    const EDITED = "00000000-0000-4000-8000-0000000000d5"
    const OTHER = "00000000-0000-4000-8000-0000000000d6"
    const entry = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      version: 3,
      state: "scheduled",
      reason: null,
      sendAt: "2099-01-10T07:30:00.000Z",
      createdAt: when,
      updatedAt: when,
      author: { id: "u1", name: "Agent Name" },
      editable: id === EDITED,
      from: "help@example.com",
      to: [{ address: "dana@example.com", name: "Dana Customer" }],
      cc: [],
      text: "Hello",
      html: "<p>Hello</p>",
      setPending: false,
      files: [],
      messageId: null,
      outboxState: null,
      ...over,
    })
    let edited: Record<string, unknown> = entry(EDITED)
    let answer: TransportResponse = { status: 409, body: { error: "scheduled_changed" } }
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": () =>
        view("v1", [], false, {}, [{ id: ORG_B, name: "Beta" }], [edited, entry(OTHER, { editable: false })]),
      [`/api/v1/scheduled/${OTHER}/cancel`]: () => {
        // Meanwhile another tab saved a newer version of the reply being changed here.
        edited = entry(EDITED, { version: 4, text: "Newer", html: "<p>Newer</p>" })
        return ok({ ok: true })
      },
      [`/api/v1/scheduled/${EDITED}/cancel`]: () => {
        edited = entry(EDITED, { state: "cancelled", reason: "agent" })
        return ok({ ok: true })
      },
      [`/api/v1/scheduled/${EDITED}`]: () => answer,
      "/api/v1/tickets/7/messages": { status: 201, body: { id: "00000000-0000-4000-8000-0000000000bb" } },
    })
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-scheduled="${id}"]`)
    await vi.waitFor(() => expect(card(EDITED)).not.toBeNull())
    await act(async () => button(he("scheduled.change"))?.click())
    await vi.waitFor(() => expect(document.querySelector(`.ui-composer[data-editing="${EDITED}"]`)).not.toBeNull())
    const views = () => requests.filter((r) => r.method === "GET" && r.url.startsWith("/api/v1/tickets/7")).length
    const cancel = async (id: string) => {
      const before = views()
      await act(async () => card(id)?.querySelector<HTMLButtonElement>('[data-testid="scheduled-cancel"]')?.click())
      await vi.waitFor(() => expect(document.querySelector("[role=alertdialog]")).not.toBeNull())
      const yes = Array.from(document.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")).find(
        (b) => b.textContent?.trim() === he("scheduled.cancel"),
      )
      await act(async () => yes?.click())
      await vi.waitFor(() => expect(views()).toBeGreaterThan(before))
    }
    const save = async () => {
      await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="composer-later"]')?.click())
      await vi.waitFor(() => expect(document.querySelector('[data-testid="composer-when"]')).not.toBeNull())
      await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="composer-when-submit"]')?.click())
    }
    const puts = () => requests.filter((r) => r.method === "PUT" && r.url === `/api/v1/scheduled/${EDITED}`)

    // A newer version arrived in the view: saving still names the version the composer loaded, and the server refuses.
    await cancel(OTHER)
    await save()
    await vi.waitFor(() => expect(puts()).toHaveLength(1))
    const first = JSON.parse(puts()[0]?.body ?? "null") as { version: number; html: string }
    expect(first.version).toBe(3)
    expect(first.html).toContain("Hello")
    await vi.waitFor(() => expect(text()).toContain(he("errors.code.scheduledChanged")))
    await act(async () =>
      document.querySelector<HTMLButtonElement>(`[role=dialog] button[aria-label="${he("common.close")}"]`)?.click(),
    )
    await vi.waitFor(() => expect(document.querySelector('[data-testid="composer-when"]')).toBeNull())

    // The reply was cancelled meanwhile: the change stays on it, the server's refusal shows, and nothing new is sent.
    answer = { status: 409, body: { error: "scheduled_not_open" } }
    await cancel(EDITED)
    expect(document.querySelector(`.ui-composer[data-editing="${EDITED}"]`)).not.toBeNull()
    await save()
    await vi.waitFor(() => expect(puts()).toHaveLength(2))
    expect(JSON.parse(puts()[1]?.body ?? "null")).toMatchObject({ version: 3 })
    await vi.waitFor(() => expect(text()).toContain(he("errors.code.scheduledNotOpen")))
    expect(requests.some((r) => r.method === "POST" && r.url === "/api/v1/tickets/7/messages")).toBe(false)
  })

  it("asks before a change to another scheduled reply drops unsaved edits of the one being changed (review T11)", async () => {
    const FIRST = "00000000-0000-4000-8000-0000000000d7"
    const SECOND = "00000000-0000-4000-8000-0000000000d8"
    const entry = (id: string, address: string) => ({
      id,
      version: 1,
      state: "scheduled",
      reason: null,
      sendAt: "2099-01-10T07:30:00.000Z",
      createdAt: when,
      updatedAt: when,
      author: { id: "u1", name: "Agent Name" },
      editable: true,
      from: "help@example.com",
      to: [{ address, name: null }],
      cc: [],
      text: "Hello",
      html: "<p>Hello</p>",
      setPending: false,
      files: [],
      messageId: null,
      outboxState: null,
    })
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view(
        "v1",
        [],
        false,
        {},
        [{ id: ORG_B, name: "Beta" }],
        [entry(FIRST, "dana@example.com"), entry(SECOND, "lee@example.com")],
      ),
    })
    const change = async (id: string) => {
      const card = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>(`[data-scheduled="${id}"]`)
        expect(found).not.toBeNull()
        return found as HTMLElement
      })
      const found = Array.from(card.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === he("scheduled.change"),
      )
      await act(async () => found?.click())
    }
    const editingId = () => document.querySelector(".ui-composer")?.getAttribute("data-editing")
    const toField = () => document.querySelector<HTMLInputElement>('.ui-composer input[id$="-to"]') as HTMLInputElement
    const answer = async (label: string) => {
      const question = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>("[role=alertdialog]")
        expect(found).not.toBeNull()
        return found as HTMLElement
      })
      const found = Array.from(question.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
      await act(async () => found?.click())
      await vi.waitFor(() => expect(document.querySelector("[role=alertdialog]")).toBeNull())
    }

    // Nothing changed in the first: the second loads at once.
    await change(FIRST)
    await vi.waitFor(() => expect(editingId()).toBe(FIRST))
    await change(SECOND)
    await vi.waitFor(() => expect(editingId()).toBe(SECOND))
    expect(document.querySelector("[role=alertdialog]")).toBeNull()
    expect(toField().value).toBe("lee@example.com")

    // An unsaved edit: the switch asks; keeping it stays on the reply being changed, with the edit.
    await act(async () => type(toField(), "kim@example.com"))
    await change(FIRST)
    await answer(he("unsaved.keepEditing"))
    await vi.waitFor(() => expect(editingId()).toBe(SECOND))
    expect(toField().value).toBe("kim@example.com")

    // Discarding it loads the other reply.
    await change(FIRST)
    await answer(he("unsaved.discard"))
    await vi.waitFor(() => expect(editingId()).toBe(FIRST))
    expect(toField().value).toBe("dana@example.com")
  })

  it("starts a new submission after a refusal, and keeps it while no answer came (review T8)", async () => {
    const answers: TransportResponse[] = [
      { status: 500, body: { error: "internal" } },
      { status: 409, body: { error: "submission_reused" } },
      { status: 201, body: { id: "00000000-0000-4000-8000-0000000000bb" } },
    ]
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view(),
      "/api/v1/tickets/7/messages": () => answers.shift() ?? ok({}),
    })
    const box = () => document.querySelector<HTMLInputElement>('.ui-composer-ticket-files input[type="checkbox"]')
    await vi.waitFor(() => expect(box()).not.toBeNull())
    await act(async () => box()?.click())
    const posts = () =>
      requests
        .filter((r) => r.method === "POST" && r.url === "/api/v1/tickets/7/messages")
        .map((r) => (JSON.parse(r.body ?? "null") as { submissionId: string }).submissionId)
    const send = async (count: number) => {
      await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')?.click())
      await vi.waitFor(() => expect(posts()).toHaveLength(count))
    }
    // The server failed without saying whether it wrote: the retry is the same submission.
    await send(1)
    await vi.waitFor(() => expect(text()).toContain(he("errors.server")))
    await send(2)
    expect(posts()[1]).toBe(posts()[0])
    // A refusal wrote nothing: the next click is a new submission.
    await vi.waitFor(() => expect(text()).toContain(he("errors.code.submissionReused")))
    await send(3)
    expect(posts()[2]).not.toBe(posts()[1])
  })

  it("offers Send again for a failed reply, but not for a scheduled reply that ended before it went out (review T7)", async () => {
    const failed = (id: string, scheduledEnded: boolean) =>
      reply({
        id,
        scheduled: true,
        delivery: {
          state: "failed",
          problem: "listening",
          unmatchedDelivery: null,
          scheduledEnded,
          recipients: [
            { address: "dana@example.com", name: null, kind: "to", state: "pending", provider: null, marked: false },
          ],
        },
      })
    const ENDED = "00000000-0000-4000-8000-0000000000a1"
    const PASSED = "00000000-0000-4000-8000-0000000000a2"
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view("v1", [failed(ENDED, true), failed(PASSED, false)]),
    })
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-message="${id}"]`)
    await vi.waitFor(() => expect(card(PASSED)).not.toBeNull())
    const resend = (id: string) =>
      Array.from(card(id)?.querySelectorAll("button") ?? []).filter(
        (b) => b.textContent?.trim() === he("delivery.resend"),
      )
    expect(card(ENDED)?.textContent).toContain(he("delivery.problem.listening"))
    expect(resend(ENDED)).toHaveLength(0)
    expect(resend(PASSED)).toHaveLength(1)
  })

  it("shows the reminder that has not gone yet, and a sent one as the organization's, never offered again (plan 4.3)", async () => {
    const SENT = "00000000-0000-4000-8000-0000000000b1"
    const due = "2026-11-15T07:30:00.000Z"
    const sent = reply({
      id: SENT,
      author: null,
      reminder: true,
      delivery: {
        state: "unknown",
        problem: null,
        unmatchedDelivery: null,
        scheduledEnded: false,
        reminder: true,
        reminderResend: false,
        recipients: [
          { address: "dana@example.com", name: null, kind: "to", state: "unknown", provider: "smtp2go", marked: false },
        ],
      },
    })
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view("v1", [sent], false, { status: "pending" }, undefined, [], {
        id: "00000000-0000-4000-8000-0000000000b2",
        dueAt: due,
        state: "scheduled",
      }),
    })
    const card = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-testid="ticket-reminder"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    // When it goes, in Israel time, and what stops it.
    expect(card.textContent).toContain(he("reminder.title"))
    expect(card.textContent).toContain(he("reminder.goesAt"))
    expect(card.querySelector("time")?.getAttribute("datetime")).toBe(due)
    expect(card.textContent).toContain(he("reminder.hint"))
    // The sent one: marked, under the organization's name, and without Send again (Mark as sent stays).
    const message = document.querySelector<HTMLElement>(`[data-message="${SENT}"]`) as HTMLElement
    expect(message.textContent).toContain(he("ticket.reminder"))
    expect(message.textContent).toContain("Alpha")
    expect(message.textContent).not.toContain(he("ticket.scheduledReply"))
    expect(message.textContent).toContain(he("delivery.reminderOnce"))
    const labels = Array.from(message.querySelectorAll("button")).map((b) => b.textContent?.trim())
    expect(labels).not.toContain(he("delivery.resend"))
    expect(labels).toContain(he("delivery.markSent"))
  })

  it("offers Send again for a failed reminder only while the server says it may go again (plan 4.3)", async () => {
    const refused = { address: "dana@example.com", name: null, kind: "to", state: "refused", marked: false }
    const failed = (id: string, reminderResend: boolean) =>
      reply({
        id,
        author: null,
        reminder: true,
        delivery: {
          state: "failed",
          problem: null,
          unmatchedDelivery: null,
          scheduledEnded: false,
          reminder: true,
          reminderResend,
          recipients: [{ ...refused, provider: "smtp2go" }],
        },
      })
    const OPEN = "00000000-0000-4000-8000-0000000000c1"
    const ENDED = "00000000-0000-4000-8000-0000000000c2"
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view("v1", [failed(OPEN, true), failed(ENDED, false)], false, { status: "pending" }),
    })
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-message="${id}"]`)
    await vi.waitFor(() => expect(card(ENDED)).not.toBeNull())
    const resend = (id: string) =>
      Array.from(card(id)?.querySelectorAll("button") ?? []).filter(
        (b) => b.textContent?.trim() === he("delivery.resend"),
      )
    expect(resend(OPEN)).toHaveLength(1)
    expect(resend(ENDED)).toHaveLength(0)
  })

  it("shows a scheduled reply still waiting minutes after its time as late, with the way out (plan 4.2)", async () => {
    const LATE = "00000000-0000-4000-8000-0000000000d1"
    const RECENT = "00000000-0000-4000-8000-0000000000d2"
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    const entry = (id: string, sendAt: string) => ({
      id,
      version: 1,
      state: "scheduled",
      reason: null,
      sendAt,
      createdAt: when,
      updatedAt: when,
      author: { id: "u1", name: "Agent Name" },
      editable: true,
      from: "help@example.com",
      to: [{ address: "dana@example.com", name: "Dana Customer" }],
      cc: [],
      text: "Hello",
      html: "<p>Hello</p>",
      setPending: false,
      files: [],
      messageId: null,
      outboxState: null,
    })
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view(
        "v1",
        [],
        false,
        {},
        [{ id: ORG_B, name: "Beta" }],
        [entry(LATE, ago(45)), entry(RECENT, ago(10))],
      ),
    })
    const card = (id: string) =>
      vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>(`[data-scheduled="${id}"]`)
        expect(found).not.toBeNull()
        return found as HTMLElement
      })
    // 45 minutes past its time and still scheduled (its job and the worker's retries did not send it): the view says so
    // and offers the way out.
    const late = await card(LATE)
    expect(late.getAttribute("data-late")).toBe("true")
    expect(late.textContent).toContain(he("scheduled.state.late"))
    expect(late.textContent).toContain(he("scheduled.wasAt"))
    expect(late.querySelector('[data-testid="scheduled-late"]')?.textContent).toBe(he("scheduled.late"))
    expect(late.querySelector('[data-testid="scheduled-cancel"]')).not.toBeNull()
    // Ten minutes past its time is within the worker's retries: still scheduled, nothing said.
    const recent = await card(RECENT)
    expect(recent.hasAttribute("data-late")).toBe(false)
    expect(recent.textContent).toContain(he("scheduled.state.scheduled"))
    expect(recent.textContent).not.toContain(he("scheduled.state.late"))
    expect(recent.querySelector('[data-testid="scheduled-late"]')).toBeNull()
  })

  it("snoozes a ticket until a time in Israel time, and ends the snooze by hand (plan 4.2)", async () => {
    let snoozed: string | null = null
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": () => view("v1", [], false, { snoozedUntil: snoozed }),
      "/api/v1/tickets/7/snooze": (request) => {
        snoozed = request.method === "PUT" ? (JSON.parse(request.body ?? "{}") as { until: string }).until : null
        return ok({ ok: true })
      },
    })
    const control = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-testid="ticket-snooze"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(control.textContent).toContain(he("ticket.snooze.none"))
    await act(async () => button(he("ticket.snooze.open"))?.click())
    const form = await vi.waitFor(() => {
      const found = document.querySelector<HTMLFormElement>('[data-testid="snooze-when"]')
      expect(found).not.toBeNull()
      return found as HTMLFormElement
    })
    await act(async () => {
      type(form.querySelector('input[type="date"]') as HTMLInputElement, "2099-07-01")
      type(form.querySelector('input[data-field="time"]') as HTMLInputElement, "08:00")
    })
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="snooze-when-submit"]')?.click())
    await vi.waitFor(() => {
      const put = requests.find((r) => r.method === "PUT" && r.url === "/api/v1/tickets/7/snooze")
      // Summer time: 08:00 in Israel is 05:00 UTC.
      expect(JSON.parse(put?.body ?? "null")).toEqual({ until: "2099-07-01T05:00:00.000Z" })
    })
    await vi.waitFor(() => expect(control.getAttribute("data-snoozed")).toBe(""))
    expect(text()).toContain(he("ticket.snooze.tag", { time: "01/07/2099 08:00" }))
    await act(async () => button(he("ticket.snooze.end"))?.click())
    await vi.waitFor(() =>
      expect(requests.some((r) => r.method === "DELETE" && r.url === "/api/v1/tickets/7/snooze")).toBe(true),
    )
  })

  it("still offers to end a snooze whose time passed while its end is late (review T2)", async () => {
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view("v1", [], false, { snoozedUntil: null, snoozeOverdue: true }),
      "/api/v1/tickets/7/snooze": ok({ ok: true }),
    })
    await vi.waitFor(() => expect(document.querySelector('[data-testid="ticket-snooze"]')).not.toBeNull())
    await act(async () => button(he("ticket.snooze.end"))?.click())
    await vi.waitFor(() =>
      expect(requests.some((r) => r.method === "DELETE" && r.url === "/api/v1/tickets/7/snooze")).toBe(true),
    )
  })

  it("shows a ticket's messages in a sandboxed frame, what was blocked, and each file's status in words", async () => {
    await renderAt("/tickets/7", { "/api/setup/status": status(), "/api/v1/me": admin, "/api/v1/tickets/7": view() })
    const frame = await vi.waitFor(() => {
      const found = document.querySelector<HTMLIFrameElement>("iframe.ui-mail-frame")
      expect(found).not.toBeNull()
      return found as HTMLIFrameElement
    })
    expect(frame.getAttribute("src")).toBe(`/api/v1/messages/${MESSAGE}/body?v=v1`)
    // Links open in a new tab that leaves the sandbox; nothing in the frame runs or reaches Maane.
    expect(frame.getAttribute("sandbox")).toBe("allow-popups allow-popups-to-escape-sandbox")
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(frame.style.height).toBe("140px")
    expect(text()).toContain(translate("he", "ticket.imagesHidden.two", { count: "2" }))
    await act(async () => button(he("ticket.showImages"))?.click())
    expect(frame.getAttribute("src")).toBe(`/api/v1/messages/${MESSAGE}/body?v=v1&images=1`)
    expect(text()).toContain(he("ticket.imagesShown"))

    // The message's own review flag, and the blocked text: its words and its signature, never its content.
    expect(document.querySelector(".ui-message-head")?.textContent).toContain(he("flag.blocked_content"))
    const notice = document.querySelector('[data-field="text"]')
    expect(notice?.textContent).toContain(he("scan.status.infected"))
    expect(notice?.querySelector('bdi[dir="ltr"]')?.textContent).toBe("Eicar-Signature")
    // Files: a clean image previews and downloads, a blocked one does neither, a drawing only downloads.
    const photo = document.querySelector('[data-file="photo.png"]') as HTMLElement
    expect(photo.textContent).toContain(he("scan.status.clean"))
    expect(photo.querySelector("a[download]")?.getAttribute("href")).toBe("/api/v1/files/f1")
    const blocked = document.querySelector('[data-file="invoice.pdf"]') as HTMLElement
    expect(blocked.textContent).toContain(he("scan.status.infected"))
    expect(blocked.textContent).toContain("Win.Test.EICAR_HDB-1")
    expect(blocked.querySelector("a[download]")).toBeNull()
    expect(blocked.querySelector("button")).toBeNull()
    const drawing = document.querySelector('[data-file="drawing.svg"]') as HTMLElement
    expect(drawing.querySelector("a[download]")).not.toBeNull()
    expect(drawing.querySelector("button")).toBeNull()
    // The ticket's facts: the address left to right, the linked ticket, the flags.
    expect(document.querySelector('.ui-facts bdi[dir="ltr"]')?.textContent).toBe("help@example.com")
    expect(document.querySelector('.ui-facts a[href="/tickets/3"]')).not.toBeNull()
    expect(text()).toContain(he("flag.sender_not_participant"))

    await act(async () => (photo.querySelector("button") as HTMLButtonElement).click())
    const dialog = await vi.waitFor(() => {
      const found = document.querySelector('[role="dialog"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(dialog.textContent).toContain("photo.png")
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("/api/v1/files/f1/preview")
  })

  it("says a ticket it cannot read does not exist", async () => {
    await renderAt("/tickets/12", { "/api/setup/status": status(), "/api/v1/me": agent })
    await vi.waitFor(() => expect(text()).toContain(he("ticket.notFound")))
    expect(document.querySelector('[data-testid="ticket-missing"] a')?.getAttribute("href")).toBe("/")
  })

  it("reloads the frame once what its body shows changed, and keeps the remote images choice", async () => {
    let version = "v1"
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": () => view(version),
    })
    const frame = await vi.waitFor(() => {
      const found = document.querySelector<HTMLIFrameElement>("iframe.ui-mail-frame")
      expect(found).not.toBeNull()
      return found as HTMLIFrameElement
    })
    await act(async () => button(he("ticket.showImages"))?.click())
    expect(frame.getAttribute("src")).toBe(`/api/v1/messages/${MESSAGE}/body?v=v1&images=1`)
    // A waiting inline image or HTML body was decided: the next read of the ticket carries a new version.
    version = "v2"
    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await vi.waitFor(() =>
      expect(document.querySelector("iframe.ui-mail-frame")?.getAttribute("src")).toBe(
        `/api/v1/messages/${MESSAGE}/body?v=v2&images=1`,
      ),
    )
    focusManager.setFocused(undefined)
  })

  const reply = (over: Record<string, unknown> = {}) => ({
    id: "00000000-0000-4000-8000-0000000000aa",
    direction: "out",
    author: { id: "u1", name: "Agent Name" },
    receivedAt: when,
    sentAt: when,
    from: { address: "help@example.com", name: null },
    to: [{ address: "dana@example.com", name: "Dana Customer" }],
    cc: [],
    subject: "Re: Hello [#7]",
    content: "parsed",
    reviewFlags: [],
    body: "html",
    remoteImages: 0,
    bodyLines: 2,
    bodyVersion: "r1",
    fields: [],
    attachments: [],
    delivery: {
      state: "unknown",
      problem: null,
      recipients: [
        {
          address: "dana@example.com",
          name: "Dana Customer",
          kind: "to",
          state: "unknown",
          provider: "smtp2go",
          marked: false,
        },
        { address: "ron@example.com", name: null, kind: "cc", state: "accepted", provider: "failover", marked: false },
      ],
    },
    ...over,
  })

  it("starts the composer from the participants and the ticket's address, and writes only notes while listening", async () => {
    await renderAt("/tickets/7", { "/api/setup/status": status(), "/api/v1/me": admin, "/api/v1/tickets/7": view() })
    const composer = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>(".ui-composer")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(composer.getAttribute("data-kind")).toBe("reply")
    const fields = composer.querySelectorAll<HTMLInputElement>(".ui-composer-fields input")
    expect(Array.from(fields).map((input) => input.value)).toEqual(["dana@example.com", "ron@example.com"])
    expect(composer.querySelector<HTMLSelectElement>("select")?.value).toBe("help@example.com")
    expect(composer.textContent).toContain("Agent Name (Alpha)")
    expect(composer.textContent).toContain("Alpha support")
    expect(composer.querySelector(".ui-editor-text")?.getAttribute("dir")).toBe("auto")
    // Each line of the signature takes its own direction, as the email gives it.
    expect(
      Array.from(composer.querySelectorAll(".ui-composer-signature [dir]")).map((line) => [
        line.getAttribute("dir"),
        line.textContent,
      ]),
    ).toEqual([
      ["auto", "Alpha support"],
      ["auto", `${SHALOM},`],
      ["auto", "The Alpha team."],
    ])
    if (mounted) {
      const { root, host } = mounted
      await act(async () => root.unmount())
      host.remove()
      mounted = null
    }

    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view("v1", [], true),
    })
    await vi.waitFor(() => expect(text()).toContain(he("compose.listening")))
    const listening = document.querySelector<HTMLElement>(".ui-composer") as HTMLElement
    expect(listening.getAttribute("data-kind")).toBe("note")
    expect(listening.querySelector<HTMLButtonElement>('button[data-kind="reply"]')?.disabled).toBe(true)
    expect(listening.querySelector(".ui-composer-fields")).toBeNull()
  })

  it("starts a fresh composer for each ticket: another ticket's recipients and text never carry over (review R2)", async () => {
    const other = view()
    const body = other.body as { ticket: { number: number }; compose: Record<string, unknown> }
    const eight = ok({
      ...body,
      ticket: { ...body.ticket, number: 8 },
      compose: { ...body.compose, to: [{ address: "eight@example.com", name: null }], cc: [] },
    })
    // Ticket 8 first, so it is in the cache and shows at once when the agent comes back to it from ticket 7.
    await renderAt("/tickets/8", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view(),
      "/api/v1/tickets/8": eight,
    })
    const fields = () => Array.from(document.querySelectorAll<HTMLInputElement>(".ui-composer-fields input"))
    await vi.waitFor(() => expect(fields()[0]?.value).toBe("eight@example.com"))
    await act(async () => {
      await router?.navigate("/tickets/7")
    })
    await vi.waitFor(() => expect(fields()[0]?.value).toBe("dana@example.com"))
    await act(async () => type(fields()[1] as HTMLInputElement, "typed@example.com"))
    expect(fields()[1]?.value).toBe("typed@example.com")
    await act(async () => {
      await router?.navigate("/tickets/8")
    })
    await vi.waitFor(() => expect(fields()[0]?.value).toBe("eight@example.com"))
    expect(fields()[1]?.value).toBe("")
    expect(document.querySelector(".ui-editor-text")?.textContent).toBe("")
  })

  it("never carries a scheduled reply being changed to another ticket (review T4)", async () => {
    const SCHEDULED = "00000000-0000-4000-8000-0000000000d7"
    const scheduled = {
      id: SCHEDULED,
      version: 1,
      state: "scheduled",
      reason: null,
      sendAt: "2099-01-10T07:30:00.000Z",
      createdAt: when,
      updatedAt: when,
      author: { id: "u1", name: "Agent Name" },
      editable: true,
      from: "help@example.com",
      to: [{ address: "dana@example.com", name: "Dana Customer" }],
      cc: [],
      text: "Hello",
      html: "<p>Hello</p>",
      setPending: false,
      files: [],
      messageId: null,
      outboxState: null,
    }
    const body = view().body as { ticket: { number: number } }
    // Ticket 8 first, so it is in the cache and shows at once when the agent goes back to it: the page stays mounted.
    await renderAt("/tickets/8", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view("v1", [], false, {}, [{ id: ORG_B, name: "Beta" }], [scheduled]),
      "/api/v1/tickets/8": ok({ ...body, ticket: { ...body.ticket, number: 8 } }),
    })
    await vi.waitFor(() => expect(document.querySelector(".ui-composer")).not.toBeNull())
    await act(async () => {
      void router?.navigate("/tickets/7")
    })
    await vi.waitFor(() => expect(button(he("scheduled.change"))).toBeDefined())
    await act(async () => button(he("scheduled.change"))?.click())
    await vi.waitFor(() => expect(document.querySelector(`.ui-composer[data-editing="${SCHEDULED}"]`)).not.toBeNull())
    for (const number of [8, 7]) {
      await act(async () => {
        void router?.navigate(`/tickets/${number}`)
      })
      // Leaving the ticket with the reply loaded in the composer asks first (its text counts as unsaved).
      if (number === 8) {
        const question = await vi.waitFor(() => {
          const found = document.querySelector<HTMLElement>("[role=alertdialog]")
          expect(found).not.toBeNull()
          return found as HTMLElement
        })
        const leave = Array.from(question.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === he("unsaved.leave"),
        )
        await act(async () => leave?.click())
      }
      await vi.waitFor(() => expect(document.querySelector(".ui-composer")).not.toBeNull())
      await vi.waitFor(() => expect(where()).toBe(`/tickets/${number}`))
      expect(document.querySelector(".ui-composer[data-editing]")).toBeNull()
    }
  })

  it("shows each recipient's state, and sends an unknown reply again only after asking", async () => {
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view("v1", [reply()]),
      "/api/v1/messages/00000000-0000-4000-8000-0000000000aa/resend": ok({ ok: true }),
      "/api/v1/messages/00000000-0000-4000-8000-0000000000aa/mark-sent": ok({ ok: true }),
    })
    await vi.waitFor(() => expect(text()).toContain(he("delivery.unknownTitle")))
    const card = document.querySelector('[data-direction="out"]') as HTMLElement
    expect(card.textContent).toContain("Agent Name")
    expect(card.querySelector('[data-recipient="dana@example.com"]')?.getAttribute("data-state")).toBe("unknown")
    expect(card.querySelector('[data-recipient="ron@example.com"]')?.textContent).toContain(
      he("delivery.provider.failover"),
    )
    // The recipients show once, in the sending list, not again in the header.
    expect(card.querySelector(".ui-message-to")).toBeNull()
    // Mark as sent is per recipient, and only for one whose fate is unknown (review R4).
    expect(card.querySelector('[data-mark="ron@example.com"]')).toBeNull()
    await act(async () => card.querySelector<HTMLButtonElement>('[data-mark="dana@example.com"]')?.click())
    await vi.waitFor(() => expect(document.querySelector("[role=alertdialog]")).not.toBeNull())
    await act(async () => document.querySelector<HTMLButtonElement>("[role=alertdialog] .ui-btn-primary")?.click())
    await vi.waitFor(() => {
      const marked = requests.find((r) => r.method === "POST" && r.url.endsWith("/mark-sent"))
      expect(JSON.parse(marked?.body ?? "null")).toEqual({ address: "dana@example.com" })
    })
    await vi.waitFor(() => expect(document.querySelector("[role=alertdialog]")).toBeNull())

    await act(async () => button(he("delivery.resend"))?.click())
    await vi.waitFor(() => expect(document.querySelector("[role=alertdialog]")).not.toBeNull())
    expect(requests.some((r) => r.url.endsWith("/resend"))).toBe(false)
    await act(async () => document.querySelector<HTMLButtonElement>("[role=alertdialog] .ui-btn-primary")?.click())
    await vi.waitFor(() => expect(requests.some((r) => r.method === "POST" && r.url.endsWith("/resend"))).toBe(true))
  })

  it("shows each recipient's delivery status next to the reply, and an event it could not tie to a recipient", async () => {
    const delivered = reply({
      delivery: {
        state: "accepted",
        problem: null,
        unmatchedDelivery: {
          source: "webhook",
          recordedAt: when,
          status: "soft_bounce",
          at: when,
          recipient: "lea@example.com",
          messageId: "reply-1@example.com",
        },
        recipients: [
          {
            address: "dana@example.com",
            name: "Dana Customer",
            kind: "to",
            state: "accepted",
            provider: "smtp2go",
            marked: false,
            delivery: "hard_bounce",
            deliveryAt: when,
            deliveryDetail: "550 5.1.1 mailbox unavailable",
          },
          {
            address: "ron@example.com",
            name: null,
            kind: "cc",
            state: "accepted",
            provider: "smtp2go",
            marked: false,
            delivery: "delivered",
            deliveryAt: when,
            deliveryDetail: null,
          },
          {
            address: "lea@example.com",
            name: null,
            kind: "cc",
            state: "accepted",
            provider: "failover",
            marked: false,
            delivery: null,
            deliveryAt: null,
            deliveryDetail: null,
          },
        ],
      },
    })
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view("v1", [delivered]),
    })
    await vi.waitFor(() => expect(text()).toContain(he("delivery.unmatched")))
    // What the unmatched event said is shown: its status, time, recipient, and Message-ID.
    const unmatched = document.querySelector('[data-unmatched="webhook"]') as HTMLElement
    expect(unmatched.textContent).toContain(he("delivery.status.soft_bounce"))
    expect(unmatched.textContent).toContain("lea@example.com")
    expect(unmatched.textContent).toContain("reply-1@example.com")
    expect(unmatched.querySelector("time")).not.toBeNull()
    const card = document.querySelector('[data-direction="out"]') as HTMLElement
    const dana = card.querySelector('[data-recipient="dana@example.com"]') as HTMLElement
    expect(dana.querySelector("[data-delivery]")?.getAttribute("data-delivery")).toBe("hard_bounce")
    expect(dana.textContent).toContain(he("delivery.status.hard_bounce"))
    expect(dana.querySelector(".ui-delivery-detail")?.getAttribute("dir")).toBe("ltr")
    expect(dana.textContent).toContain("550 5.1.1 mailbox unavailable")
    expect(dana.querySelector("time")).not.toBeNull()
    expect(card.querySelector('[data-recipient="ron@example.com"]')?.textContent).toContain(
      he("delivery.status.delivered"),
    )
    expect(card.querySelector('[data-recipient="lea@example.com"] [data-delivery]')).toBeNull()
  })

  it("shows a reply's clicked links and downloaded files: the flag first, the address left to right (plan 3.4)", async () => {
    const click = (over: Record<string, unknown>) => ({
      id: 1,
      at: when,
      ip: "192.0.2.10",
      country: "il",
      city: "Tel Aviv",
      region: "Tel Aviv District",
      isp: "Example Net",
      asn: 64496,
      device: "desktop",
      os: "Windows 10",
      browser: "Chrome 131",
      userAgent: "Mozilla/5.0",
      scanner: [],
      ...over,
    })
    const links = [
      {
        id: "link-1",
        kind: "url",
        // A scanner kept clicking: the server sent only the newest clicks, with the total.
        total: 120,
        target: "https://www.example.com/guide",
        clicks: [
          click({
            id: 2,
            ip: "2001:db8::5",
            country: null,
            city: null,
            region: null,
            isp: null,
            asn: 8075,
            scanner: ["early", "network"],
          }),
          click({ id: 1 }),
        ],
      },
      {
        id: "link-2",
        kind: "file",
        target: "invoice.pdf",
        total: 1,
        clicks: [click({ id: 3, device: "bot", scanner: ["agent"] })],
      },
      // Two history files of one name (image001.png is common in mail): each its own row.
      { id: "link-3", kind: "file", target: "invoice.pdf", total: 1, clicks: [click({ id: 4 })] },
    ]
    await renderAt("/tickets/7", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/tickets/7": view("v1", [reply({ links })]),
    })
    const section = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-direction="out"] .ui-clicks')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(section.getAttribute("aria-label")).toBe(he("links.title"))
    const [guide, file, same] = Array.from(section.querySelectorAll<HTMLElement>(".ui-clicks-links > li"))
    expect(same?.textContent).toContain("invoice.pdf")
    expect(section.querySelectorAll(".ui-clicks-links > li")).toHaveLength(3)
    expect(guide?.getAttribute("data-kind")).toBe("url")
    expect(guide?.querySelector(".ui-clicks-target")?.getAttribute("dir")).toBe("ltr")
    expect(guide?.textContent).toContain("https://www.example.com/guide")
    expect(guide?.textContent).toContain(translateCount("he", "links.count", 120))
    expect(guide?.querySelector(".ui-clicks-shown")?.textContent).toBe(he("links.shown", { shown: "2", total: "120" }))
    expect(file?.querySelector(".ui-clicks-shown")).toBeNull()
    const rows = Array.from(guide?.querySelectorAll<HTMLElement>(".ui-clicks-list > li") ?? [])
    // The newest first, as the server orders them: a scanner's click with no country, then the customer's.
    expect(rows[0]?.getAttribute("data-scanner")).toBe("yes")
    expect(rows[0]?.textContent).toContain(he("links.scanner"))
    expect(rows[0]?.textContent).toContain(he("links.scannerReason.early"))
    expect(rows[0]?.querySelector(".ui-click-flag-none")).not.toBeNull()
    const customer = rows[1] as HTMLElement
    expect(customer.getAttribute("data-scanner")).toBe("no")
    // The flag is the first thing in reading order, then the address isolated left to right.
    const [first, second] = Array.from(customer.children)
    expect(first?.className).toContain("fi fi-il")
    expect(first?.getAttribute("aria-label")).toBe(he("links.country", { code: "IL" }))
    expect(second?.tagName).toBe("BDI")
    expect(second?.getAttribute("dir")).toBe("ltr")
    expect(second?.textContent).toBe("192.0.2.10")
    // The city, region, and ISP: the address's tooltip, and written under it for a phone.
    const place = [
      he("links.city", { value: "Tel Aviv" }),
      he("links.region", { value: "Tel Aviv District" }),
      he("links.isp", { value: `Example Net (${he("links.asn", { value: "64496" })})` }),
    ]
    expect(second?.getAttribute("title")).toBe(place.join("\n"))
    expect(customer.querySelector(".ui-click-place")?.textContent).toBe(place.join(" · "))
    expect(customer.textContent).toContain(he("links.device.desktop"))
    expect(file?.getAttribute("data-kind")).toBe("file")
    expect(file?.textContent).toContain("invoice.pdf")
    expect(file?.textContent).toContain(he("links.scannerReason.agent"))
    // A reply nobody clicked shows no section.
    expect(document.querySelectorAll(".ui-clicks")).toHaveLength(1)
  })

  it("ends a PDF that finishes loading after its preview closed, and starts none once it closed", async () => {
    let release: ((response: Response) => void) | null = null
    const downloads = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    vi.stubGlobal("fetch", downloads)
    try {
      await renderAt("/tickets/7", { "/api/setup/status": status(), "/api/v1/me": admin, "/api/v1/tickets/7": view() })
      const row = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>('[data-file="copy.pdf"]')
        expect(found).not.toBeNull()
        return found as HTMLElement
      })
      const closeDialog = async () => {
        const close = document.querySelector<HTMLButtonElement>(
          `[role="dialog"] button[aria-label="${he("common.close")}"]`,
        )
        await act(async () => close?.click())
        await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
      }
      const finishDownload = async () => {
        await vi.waitFor(() => expect(release).not.toBeNull())
        await act(async () => {
          release?.(new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46])))
          release = null
          await new Promise((resolve) => setTimeout(resolve, 20))
        })
      }

      // Closed while the file still downloads: pdf.js never starts.
      await act(async () => (row.querySelector("button") as HTMLButtonElement).click())
      await closeDialog()
      await finishDownload()
      expect(pdf.openPdf).not.toHaveBeenCalled()

      // Closed while pdf.js loads: no document is ever started.
      let loaded: ((pdfjs: unknown) => void) | null = null
      pdf.loadPdfJs.mockImplementation(
        () =>
          new Promise((resolve) => {
            loaded = resolve
          }),
      )
      await act(async () => (row.querySelector("button") as HTMLButtonElement).click())
      await finishDownload()
      await vi.waitFor(() => expect(loaded).not.toBeNull())
      await closeDialog()
      await act(async () => {
        loaded?.({})
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(pdf.openPdf).not.toHaveBeenCalled()

      // Closed while the document opens: its loading task is destroyed.
      const opening = { destroy: vi.fn(async () => {}), promise: new Promise(() => {}) }
      pdf.loadPdfJs.mockResolvedValue({})
      pdf.openPdf.mockReturnValue(opening)
      await act(async () => (row.querySelector("button") as HTMLButtonElement).click())
      await finishDownload()
      await vi.waitFor(() => expect(pdf.openPdf).toHaveBeenCalledTimes(1))
      await closeDialog()
      expect(opening.destroy).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("never asks for a ticket whose number is not a number", async () => {
    await renderAt("/tickets/abc", { "/api/setup/status": status(), "/api/v1/me": agent })
    await vi.waitFor(() => expect(text()).toContain(he("ticket.notFound")))
    expect(requests.some((r) => r.url.includes("/tickets/abc"))).toBe(false)
  })
})

describe("categories", () => {
  const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
  const listed = ok({
    categories: [
      {
        id: "2f9e8b2a-8c77-4da0-9e77-7b2d8c5a4c33",
        name: "Billing",
        tickets: 2,
        createdAt: "2026-11-12T08:00:00.000Z",
      },
      {
        id: "3a0f9c3b-9d88-4eb1-8f88-8c3e9d6b5d44",
        name: "Shipping",
        tickets: 0,
        createdAt: "2026-11-12T08:00:00.000Z",
      },
    ],
  })

  it("lists every category with its tickets, adds one, and is locked for an agent (plan 4.1)", async () => {
    await renderAt("/categories", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/admin/categories": (request) =>
        request.method === "POST" ? { status: 201, body: { category: { id: "x", name: "Returns" } } } : listed,
    })
    await vi.waitFor(() => expect(document.querySelector('[data-category="Billing"]')).not.toBeNull())
    expect(document.querySelector('[data-category="Billing"]')?.textContent).toContain(
      translate("he", "categories.ticketCount.two", { count: "2" }),
    )
    await act(async () => button(he("categories.create"))?.click())
    const input = await vi.waitFor(() => {
      const found = document.querySelector<HTMLInputElement>("[role=dialog] input")
      expect(found).not.toBeNull()
      return found as HTMLInputElement
    })
    await act(async () => type(input, "  Returns "))
    await act(async () => document.querySelector<HTMLButtonElement>("[role=dialog] button[type=submit]")?.click())
    await vi.waitFor(() => {
      const post = requests.find((r) => r.method === "POST" && r.url === "/api/v1/admin/categories")
      expect(JSON.parse(post?.body ?? "null")).toEqual({ name: "Returns" })
    })
    if (mounted) {
      const { root, host } = mounted
      await act(async () => root.unmount())
      host.remove()
      mounted = null
    }
    await renderAt("/categories", { "/api/setup/status": status(), "/api/v1/me": agent })
    await vi.waitFor(() => expect(text()).toContain(he("adminOnly.title")))
    expect(requests.some((r) => r.url === "/api/v1/admin/categories")).toBe(false)
  })
})

describe("the intake log", () => {
  const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
  const entry = (over: Record<string, unknown>) => ({
    messageId: "m1",
    at: "2026-11-12T08:00:00.000Z",
    receivedAt: "2026-11-12T08:00:00.000Z",
    mode: "live",
    outcome: "new_ticket",
    classification: "customer",
    reasons: [],
    matchLayer: null,
    subject: "Hello",
    from: { address: "dana@example.com", name: null },
    supportAddress: "help@example.com",
    organization: { id: "o1", name: "Alpha" },
    ticket: 7,
    matchedTicket: null,
    flags: [],
    ...over,
  })

  it("shows what intake did, and what it would have done while listening", async () => {
    await renderAt("/intake", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/intake": ok({
        entries: [
          entry({
            messageId: "m2",
            mode: "listening",
            outcome: "joined",
            ticket: null,
            matchedTicket: 7,
            reasons: ["sender_not_participant"],
            flags: ["sender_not_participant"],
          }),
          entry({ outcome: "automated", ticket: null, reasons: ["auto_submitted", "list", "planted_code"] }),
        ],
        next: null,
      }),
    })
    const heard = await vi.waitFor(() => {
      const found = document.querySelector('[data-message="m2"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(heard.textContent).toContain(he("intake.outcomeWould.joined"))
    expect(heard.textContent).toContain(he("intake.mode.listening"))
    expect(heard.textContent).toContain(he("flag.sender_not_participant"))
    expect(heard.querySelector('a[href="/tickets/7"]')).not.toBeNull()
    const live = document.querySelector('[data-message="m1"]') as HTMLElement
    expect(live.textContent).toContain(he("intake.outcome.automated"))
    // Every reason in words, never its code; a code the UI does not know yet shows as it is, left to right.
    expect(heard.querySelector('[data-reason="sender_not_participant"]')?.textContent).toBe(
      he("intake.reason.sender_not_participant"),
    )
    expect(live.querySelector('[data-reason="auto_submitted"]')?.textContent).toBe(he("intake.reason.auto_submitted"))
    expect(live.querySelector('[data-reason="list"]')?.textContent).toContain(he("intake.reason.list"))
    expect(live.textContent).not.toContain("auto_submitted")
    expect(live.querySelector('[data-reason="planted_code"] bdi[dir="ltr"]')?.textContent).toBe("planted_code")
    expect(live.querySelector('.ui-item-meta bdi[dir="ltr"].ui-mono')?.textContent).toBe("dana@example.com")
    await act(async () => button(he("intake.mode.listening"))?.click())
    await vi.waitFor(() => expect(where()).toBe("/intake?mode=listening"))
    expect(requests.some((r) => r.url === "/api/v1/intake?mode=listening")).toBe(true)
  })

  it("is locked for an agent, who never reads it", async () => {
    session.set({ session: { id: "current" }, user: { id: "u2", role: "agent" } })
    await renderAt("/intake", { "/api/setup/status": status(), "/api/v1/me": agent })
    await vi.waitFor(() => expect(text()).toContain(he("adminOnly.title")))
    expect(requests.some((r) => r.url.startsWith("/api/v1/intake"))).toBe(false)
  })
})

describe("browser notifications on this device", () => {
  const ENDPOINT = "https://updates.push.services.mozilla.com/wpush/v2/device-one"
  const PUBLIC_KEY = "BPublicKeyOfMaane"
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label) ?? null

  /** A browser with push: what it did, in order, next to the requests the transport answered. */
  function fakeDevice(subscribed: boolean, fails: { current?: boolean; unsubscribe?: boolean } = {}) {
    const events: string[] = []
    const subscription = (): DeviceSubscription => ({
      endpoint: ENDPOINT,
      keys: { p256dh: "p256dh-of-the-browser", auth: "auth-of-the-browser" },
      unsubscribe: async () => {
        if (fails.unsubscribe) throw new Error("the push service did not answer")
        events.push("unsubscribe")
        current = null
      },
    })
    let current: DeviceSubscription | null = subscribed ? subscription() : null
    setPushDevice({
      supported: () => true,
      permission: () => "granted",
      current: async () => {
        if (fails.current) throw new Error("the service worker is not reachable")
        return current
      },
      subscribe: async (key) => {
        events.push(`subscribe ${key}`)
        current = subscription()
        return current
      },
    })
    return events
  }

  afterEach(() => setPushDevice(browserDevice))

  it("says so when this browser cannot get notifications", async () => {
    await renderAt("/account", { "/api/setup/status": status(), "/api/v1/me": admin })
    await vi.waitFor(() => expect(text()).toContain(he("notifications.unsupported")))
    expect(requests.some((r) => r.url.startsWith("/api/v1/notifications"))).toBe(false)
  })

  it("turns them on for this device with the UI's language, and off again", async () => {
    const events = fakeDevice(false)
    let on = false
    const answers: Answers = {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/notifications/state": () => ok({ publicKey: PUBLIC_KEY, on }),
      "/api/v1/notifications/subscription": (request) => {
        events.push(`${request.method} ${request.body}`)
        on = request.method === "PUT"
        return ok({ on })
      },
    }
    await renderAt("/account", answers)
    await vi.waitFor(() => expect(text()).toContain(he("notifications.off")))
    await act(async () => button(he("notifications.turnOn"))?.click())
    await vi.waitFor(() => expect(text()).toContain(he("notifications.on")))
    expect(events).toEqual([
      `subscribe ${PUBLIC_KEY}`,
      `PUT ${JSON.stringify({ endpoint: ENDPOINT, keys: { p256dh: "p256dh-of-the-browser", auth: "auth-of-the-browser" }, locale: "he" })}`,
    ])
    await act(async () => button(he("notifications.turnOff"))?.click())
    await vi.waitFor(() => expect(text()).toContain(he("notifications.off")))
    expect(events.slice(2)).toEqual([`DELETE ${JSON.stringify({ endpoint: ENDPOINT })}`, "unsubscribe"])
  })

  /** Lets the requests and the browser calls already started finish. */
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)))

  it("ends a subscription this browser holds for someone else once a user is signed in, on any page", async () => {
    const events = fakeDevice(true)
    const answers: Answers = {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/notifications/state": ok({ publicKey: PUBLIC_KEY, on: false }),
    }
    await renderAt("/", answers)
    await vi.waitFor(() => expect(events).toEqual(["unsubscribe"]))
    const asked = requests.find((r) => r.url === "/api/v1/notifications/state")
    expect(asked?.body).toBe(JSON.stringify({ endpoint: ENDPOINT }))
  })

  it.each([
    ["this user's own subscription", ok({ publicKey: PUBLIC_KEY, on: true })],
    ["any subscription when the check fails", { status: 500, body: { error: "internal" } }],
  ])("keeps %s", async (_, state) => {
    const events = fakeDevice(true)
    await renderAt("/", { "/api/setup/status": status(), "/api/v1/me": admin, "/api/v1/notifications/state": state })
    await vi.waitFor(() => expect(requests.some((r) => r.url === "/api/v1/notifications/state")).toBe(true))
    await settle()
    expect(events).toEqual([])
  })

  it("asks again after a failed check until the server answers, and then ends someone else's subscription", async () => {
    const events = fakeDevice(true)
    let asked = 0
    const answers: Answers = {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/notifications/state": () => {
        asked += 1
        return asked === 1 ? { status: 500, body: { error: "internal" } } : ok({ publicKey: PUBLIC_KEY, on: false })
      },
    }
    await renderAt("/", answers)
    await vi.waitFor(() => expect(asked).toBe(1))
    await settle()
    expect(events).toEqual([])
    await act(async () => window.dispatchEvent(new Event("focus")))
    await vi.waitFor(() => expect(events).toEqual(["unsubscribe"]))
    expect(asked).toBe(2)
    // Answered: the checks stop.
    await act(async () => window.dispatchEvent(new Event("focus")))
    await settle()
    expect(asked).toBe(2)
  })

  it("leaves a subscription being turned on alone while a check that failed asks again", async () => {
    const events = fakeDevice(true)
    let failing = true
    let on = false
    let release = () => {}
    const answers: Answers = {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/notifications/state": () =>
        failing ? { status: 500, body: { error: "internal" } } : ok({ publicKey: PUBLIC_KEY, on }),
      // Saving the new subscription takes a while: the check below runs in between.
      "/api/v1/notifications/subscription": (request) => {
        events.push(request.method)
        return new Promise((resolve) => {
          release = () => {
            on = true
            resolve(ok({ on: true }))
          }
        })
      },
    }
    await renderAt("/", answers)
    await vi.waitFor(() => expect(requests.some((r) => r.url === "/api/v1/notifications/state")).toBe(true))
    await settle()
    failing = false
    await act(async () => router?.navigate("/account"))
    await vi.waitFor(() => expect(text()).toContain(he("notifications.off")))
    await act(async () => button(he("notifications.turnOn"))?.click())
    await vi.waitFor(() => expect(events).toContain("PUT"))
    expect(events).toEqual(["unsubscribe", `subscribe ${PUBLIC_KEY}`, "PUT"])
    // The server does not count the new subscription yet; the check must not end it.
    await act(async () => window.dispatchEvent(new Event("focus")))
    await settle()
    expect(events).toEqual(["unsubscribe", `subscribe ${PUBLIC_KEY}`, "PUT"])
    await act(async () => release())
    await vi.waitFor(() => expect(text()).toContain(he("notifications.on")))
    await act(async () => window.dispatchEvent(new Event("focus")))
    await settle()
    expect(events).toEqual(["unsubscribe", `subscribe ${PUBLIC_KEY}`, "PUT"])
  })

  it("replaces a subscription this browser holds for someone else instead of taking it over", async () => {
    const events = fakeDevice(true)
    const answers: Answers = {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/notifications/state": ok({ publicKey: PUBLIC_KEY, on: false }),
      "/api/v1/notifications/subscription": (request) => {
        events.push(request.method)
        return ok({ on: true })
      },
    }
    await renderAt("/account", answers)
    await vi.waitFor(() => expect(text()).toContain(he("notifications.off")))
    // The check on signing in ends it first; turning on then makes a new one.
    await vi.waitFor(() => expect(events).toEqual(["unsubscribe"]))
    await act(async () => button(he("notifications.turnOn"))?.click())
    await vi.waitFor(() => expect(events).toContain("PUT"))
    expect(events).toEqual(["unsubscribe", `subscribe ${PUBLIC_KEY}`, "PUT"])
  })

  it("signing out first removes this device's subscription, then ends it in the browser, then signs out", async () => {
    const events = fakeDevice(true)
    auth.signOut.mockImplementation(async () => {
      events.push("signOut")
      return { data: {}, error: null }
    })
    const answers: Answers = {
      "/api/setup/status": status(),
      // Once signed out, the session is gone, as Better Auth's signOut leaves it.
      "/api/v1/me": () => (events.includes("signOut") ? signedOut : totpRequired),
      "/api/v1/notifications/subscription": (request) => {
        events.push(`${request.method} ${request.body}`)
        return ok({ on: false })
      },
    }
    await renderAt("/enroll", answers)
    await vi.waitFor(() => expect(button(he("account.signOut"))).not.toBeNull())
    await act(async () => button(he("account.signOut"))?.click())
    await vi.waitFor(() => expect(where()).toBe("/login"))
    expect(events).toEqual([`DELETE ${JSON.stringify({ endpoint: ENDPOINT })}`, "unsubscribe", "signOut"])
  })

  it.each([
    ["fails", { status: 500, body: { error: "internal" } } as TransportResponse],
    ["refuses a session /api/v1 no longer takes", totpRequired],
  ])("signs out when the server's delete %s but the browser ends the subscription", async (_, deleted) => {
    const events = fakeDevice(true)
    auth.signOut.mockImplementation(async () => {
      events.push("signOut")
      return { data: {}, error: null }
    })
    const answers: Answers = {
      "/api/setup/status": status(),
      // Once signed out, the session is gone, as Better Auth's signOut leaves it.
      "/api/v1/me": () => (events.includes("signOut") ? signedOut : totpRequired),
      "/api/v1/notifications/subscription": deleted,
    }
    await renderAt("/enroll", answers)
    await vi.waitFor(() => expect(button(he("account.signOut"))).not.toBeNull())
    await act(async () => button(he("account.signOut"))?.click())
    await vi.waitFor(() => expect(where()).toBe("/login"))
    expect(events).toEqual(["unsubscribe", "signOut"])
  })

  it.each([
    ["end", { unsubscribe: true }],
    ["read", { current: true }],
  ])("keeps the session when the browser could not %s its subscription, and says so", async (_, fails) => {
    fakeDevice(true, fails)
    const answers: Answers = {
      "/api/setup/status": status(),
      "/api/v1/me": totpRequired,
      "/api/v1/notifications/subscription": totpRequired,
    }
    await renderAt("/enroll", answers)
    await vi.waitFor(() => expect(button(he("account.signOut"))).not.toBeNull())
    await act(async () => button(he("account.signOut"))?.click())
    await vi.waitFor(() => expect(text()).toContain(he("notifications.notForgotten")))
    expect(auth.signOut).not.toHaveBeenCalled()
    expect(where()).toBe("/enroll")
  })
})

describe("import from Zendesk", () => {
  const ORG = "0d7c6f0e-6a55-4b8e-9c55-5f0b6a3e2a11"
  const CATEGORY = "2f9e8b2a-8c77-4da0-9e77-7b2d8c5a4c33"
  const RUN = "5c1e0d4e-2b3c-4d5e-9f60-718293a4b5c6"
  const when = "2026-11-12T08:00:00.000Z"
  const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
  const page = (over: Record<string, unknown> = {}) =>
    ok({
      window: { open: true, mode: "listening", wentLiveAt: null },
      archive: {
        present: true,
        origin: "https://example.zendesk.com",
        runs: 3,
        coveredUntil: when,
        backupRunning: false,
        otherOrigin: false,
        tickets: 12,
      },
      brands: [{ id: "100", name: "Example Store", tickets: 12, organizationId: null }],
      tags: [{ tag: "vip", tickets: 4, categoryId: null }],
      agentUserId: null,
      users: [{ id: "u1", name: "Owner" }],
      organizations: [{ id: ORG, name: "Alpha" }],
      categories: [{ id: CATEGORY, name: "VIP" }],
      run: null,
      ...over,
    })
  const run = {
    id: RUN,
    state: "done",
    reason: null,
    problems: [],
    createdAt: when,
    finishedAt: when,
    coveredUntil: when,
    highestNumber: 12,
    total: 12,
    done: 12,
    counts: { tickets: 11, messages: 40, notes: 5, sideConversations: 1, links: 2, files: 9, skipped: 1 },
    reportRows: 1,
    failure: null,
    jobActive: false,
  }

  it("maps the brands and tags, saves, starts, and shows the run with its report", async () => {
    let saved = false
    await renderAt("/import", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/admin/import": () => (saved ? page({ run }) : page()),
      "/api/v1/admin/import/mapping": () => {
        saved = true
        return ok({ ok: true })
      },
      "/api/v1/admin/import/run": () => ok({ run: saved ? run : null }),
      "/api/v1/admin/import/start": { status: 202, body: { run } },
      [`/api/v1/admin/import/runs/${RUN}/report`]: ok({
        rows: [{ id: 1, zendeskId: 4, reason: "deleted_in_zendesk", detail: null }],
        next: null,
      }),
    })
    const brand = await vi.waitFor(() => {
      const found = document.querySelector<HTMLSelectElement>('[data-brand="100"] select')
      expect(found).not.toBeNull()
      return found as HTMLSelectElement
    })
    const start = () => button(he("import.run.start"))
    expect(start()?.disabled).toBe(false)
    await act(async () => {
      brand.value = ORG
      brand.dispatchEvent(new Event("change", { bubbles: true }))
    })
    const tag = document.querySelector<HTMLSelectElement>('[data-tag="vip"] select') as HTMLSelectElement
    const agent = document.querySelector<HTMLSelectElement>("#import-agent") as HTMLSelectElement
    await act(async () => {
      tag.value = CATEGORY
      tag.dispatchEvent(new Event("change", { bubbles: true }))
      agent.value = "u1"
      agent.dispatchEvent(new Event("change", { bubbles: true }))
    })
    // A changed mapping is saved before a run starts.
    expect(start()?.disabled).toBe(true)
    expect(text()).toContain(he("import.mapping.unsaved"))
    await act(async () => button(he("import.mapping.save"))?.click())
    await vi.waitFor(() => {
      const put = requests.find((r) => r.method === "PUT" && r.url === "/api/v1/admin/import/mapping")
      expect(JSON.parse(put?.body ?? "null")).toEqual({
        brands: { "100": ORG },
        tags: { vip: CATEGORY },
        agentUserId: "u1",
      })
    })
    await vi.waitFor(() => expect(start()?.disabled).toBe(false))
    await act(async () => start()?.click())
    await vi.waitFor(() =>
      expect(requests.some((r) => r.method === "POST" && r.url === "/api/v1/admin/import/start")).toBe(true),
    )
    await vi.waitFor(() => expect(text()).toContain(he("import.report.reason.deleted_in_zendesk")))
    expect(text()).toContain(he("import.run.state.done"))
    expect(text()).toContain(he("import.zendeskNumber", { number: 4 }))
  })

  it("offers Continue for an open run whose job is gone, and says which ticket stopped it and why", async () => {
    const stopped = { ...run, state: "running", reason: "failed", finishedAt: null, done: 2, jobActive: false }
    await renderAt("/import", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/admin/import": page({ agentUserId: "u1", run: stopped }),
      "/api/v1/admin/import/run": ok({ run: stopped }),
      "/api/v1/admin/import/start": { status: 202, body: { run: { ...stopped, jobActive: true } } },
      [`/api/v1/admin/import/runs/${RUN}/report`]: ok({
        rows: [{ id: 2, zendeskId: 3, reason: "ticket_failed", detail: "rule:ticket_number_rule" }],
        next: null,
      }),
    })
    await vi.waitFor(() => expect(button(he("import.run.continue"))?.disabled).toBe(false))
    expect(button(he("import.run.start"))).toBeUndefined()
    expect(text()).toContain(he("import.run.reason.failed"))
    expect(text()).toContain(he("import.run.waiting"))
    await vi.waitFor(() => expect(text()).toContain(he("import.report.failure.rule")))
    expect(text()).toContain(he("import.report.reason.ticket_failed"))
    expect(text()).toContain(he("import.zendeskNumber", { number: 3 }))
    expect(text()).toContain("ticket_number_rule")
    await act(async () => button(he("import.run.continue"))?.click())
    await vi.waitFor(() =>
      expect(requests.some((r) => r.method === "POST" && r.url === "/api/v1/admin/import/start")).toBe(true),
    )
  })

  it("names the stage and the kind of an error no ticket caused", async () => {
    const stopped = {
      ...run,
      state: "running",
      reason: "failed",
      finishedAt: null,
      done: 12,
      failure: { stage: "links", kind: "rule", constraint: "ticket_link_rule" },
    }
    await renderAt("/import", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/admin/import": page({ agentUserId: "u1", run: stopped }),
      "/api/v1/admin/import/run": ok({ run: stopped }),
      [`/api/v1/admin/import/runs/${RUN}/report`]: ok({ rows: [], next: null }),
    })
    await vi.waitFor(() => expect(text()).toContain(he("import.run.stage.links")))
    const failure = document.querySelector('[data-failure="links"]')
    expect(failure?.textContent).toContain(he("import.report.failure.rule"))
    expect(failure?.textContent).toContain("ticket_link_rule")
    expect(text()).toContain(he("import.run.reason.failed"))
  })

  it("keeps Start off while a job works on the open run", async () => {
    const working = { ...run, state: "running", finishedAt: null, done: 2, jobActive: true }
    await renderAt("/import", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/admin/import": page({ agentUserId: "u1", run: working }),
      "/api/v1/admin/import/run": ok({ run: working }),
      [`/api/v1/admin/import/runs/${RUN}/report`]: ok({ rows: [], next: null }),
    })
    await vi.waitFor(() => expect(text()).toContain(he("import.run.state.running")))
    expect(button(he("import.run.start"))?.disabled).toBe(true)
    expect(button(he("import.run.continue"))).toBeUndefined()
    expect(text()).not.toContain(he("import.run.waiting"))
  })

  it("says the import is closed for good once Maane went live", async () => {
    await renderAt("/import", {
      "/api/setup/status": status(),
      "/api/v1/me": admin,
      "/api/v1/admin/import": page({ window: { open: false, mode: "live", wentLiveAt: when } }),
    })
    await vi.waitFor(() => expect(text()).toContain(he("import.closed")))
    expect(button(he("import.run.start"))?.disabled).toBe(true)
    expect(document.querySelector<HTMLSelectElement>('[data-brand="100"] select')?.disabled).toBe(true)
  })

  it("locks the page for an agent without reading it", async () => {
    session.set({ session: { id: "current" }, user: { id: "u2", role: "agent" } })
    await renderAt("/import", { "/api/setup/status": status(), "/api/v1/me": agent })
    await vi.waitFor(() => expect(text()).toContain(he("adminOnly.title")))
    expect(requests.some((r) => r.url.startsWith("/api/v1/admin/import"))).toBe(false)
  })
})
