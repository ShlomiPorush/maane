// The app's routes in a DOM, against a stand-in for Maane's API and Better Auth's client: where each session state
// and role lands (signed out, two-factor off, agent, admin), the setup screen's states, sign-in with its second
// step, and a session that ends while a page is open. Texts are read from the locale files.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { noteAuthStatus } from "./api/auth.ts"
import { setTransport, type TransportRequest, type TransportResponse } from "./api/client.ts"
import { ERROR_VARS } from "./api/errors.ts"
import { I18nProvider, translate } from "./i18n/i18n.tsx"
import { ROUTES } from "./routes.tsx"

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
      signOut: () => Promise.resolve({ data: {}, error: null }),
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

type Answers = Record<string, TransportResponse | ((request: TransportRequest) => TransportResponse)>

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
const noTickets = ok({ tickets: [], next: null, organizations: [] })

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
  auth.listSessions.mockResolvedValue({ data: [], error: null })
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
  const view = () =>
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
      },
      participants: [{ address: "dana@example.com", name: "Dana Customer" }],
      links: [{ number: 3, reason: "sender_not_participant" }],
      messages: [
        {
          id: MESSAGE,
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
          ],
        },
      ],
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
    const select = document.querySelector<HTMLSelectElement>(".ui-filters select") as HTMLSelectElement
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

  it("shows a ticket's messages in a sandboxed frame, what was blocked, and each file's status in words", async () => {
    await renderAt("/tickets/7", { "/api/setup/status": status(), "/api/v1/me": admin, "/api/v1/tickets/7": view() })
    const frame = await vi.waitFor(() => {
      const found = document.querySelector<HTMLIFrameElement>("iframe.ui-mail-frame")
      expect(found).not.toBeNull()
      return found as HTMLIFrameElement
    })
    expect(frame.getAttribute("src")).toBe(`/api/v1/messages/${MESSAGE}/body`)
    expect(frame.getAttribute("sandbox")).toBe("")
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(frame.style.height).toBe("140px")
    expect(text()).toContain(translate("he", "ticket.imagesHidden.two", { count: "2" }))
    await act(async () => button(he("ticket.showImages"))?.click())
    expect(frame.getAttribute("src")).toBe(`/api/v1/messages/${MESSAGE}/body?images=1`)
    expect(text()).toContain(he("ticket.imagesShown"))

    // The blocked text: its words and its signature, never its content.
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

  it("never asks for a ticket whose number is not a number", async () => {
    await renderAt("/tickets/abc", { "/api/setup/status": status(), "/api/v1/me": agent })
    await vi.waitFor(() => expect(text()).toContain(he("ticket.notFound")))
    expect(requests.some((r) => r.url.includes("/tickets/abc"))).toBe(false)
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
    reason: null,
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
            flags: ["sender_not_participant"],
          }),
          entry({}),
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
    expect(live.textContent).toContain(he("intake.outcome.new_ticket"))
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
