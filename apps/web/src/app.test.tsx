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
      useSession: () => ({ data: useSyncExternalStore(session.subscribe, session.get), isPending: false }),
      listSessions: auth.listSessions,
      revokeOtherSessions: auth.revokeOtherSessions,
      signOut: () => Promise.resolve({ data: {}, error: null }),
      signIn: { username: auth.signInUsername },
      signUp: { email: auth.signUpEmail },
      twoFactor: {
        verifyTotp: auth.verifyTotp,
        verifyBackupCode: auth.verifyBackupCode,
        generateBackupCodes: auth.generateBackupCodes,
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

async function renderAt(path: string, answers: Answers): Promise<void> {
  requests = []
  setTransport(async (request) => {
    requests.push(request)
    const path = request.url.split("?")[0] ?? ""
    const answer = answers[path]
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

  it("shows an admin every page in the navigation and the empty home", async () => {
    await renderAt("/", { "/api/setup/status": status(), "/api/v1/me": admin })
    await vi.waitFor(() => expect(text()).toContain(he("home.emptyTitle")))
    const nav = document.querySelector(".ui-sidenav")?.textContent ?? ""
    for (const id of ["home", "users", "settings", "audit"]) expect(nav).toContain(he(`nav.${id}`))
  })

  it("hides admin pages from an agent and locks them on a direct address, without reading them", async () => {
    await renderAt("/users", { "/api/setup/status": status(), "/api/v1/me": agent })
    await vi.waitFor(() => expect(text()).toContain(he("adminOnly.title")))
    const nav = document.querySelector(".ui-sidenav")?.textContent ?? ""
    expect(nav).toContain(he("nav.home"))
    for (const id of ["users", "settings", "audit"]) expect(nav).not.toContain(he(`nav.${id}`))
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
