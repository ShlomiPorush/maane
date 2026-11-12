// Two-factor enrollment, step by step: the QR code names the account after the username and the key shown is
// Better Auth's; a wrong code is explained and cleared; a right one ends the other sessions before the backup codes
// are handed on; when ending them fails three times, the user can try again. Secrets are new for every run.

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider, translate } from "../../i18n/i18n.tsx"
import { SIGN_OUT_OTHERS_TRIES, TotpStep } from "./TotpStep.tsx"

const enroll = vi.hoisted(() => ({
  totpURI: "",
  drawn: [] as string[],
  enable: vi.fn(),
  verifyTotp: vi.fn(),
  revokeOtherSessions: vi.fn(),
}))

vi.mock("../../api/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/auth.ts")>()
  return {
    ...real,
    authClient: {
      twoFactor: { enable: enroll.enable, verifyTotp: enroll.verifyTotp },
      revokeOtherSessions: enroll.revokeOtherSessions,
    },
  }
})

vi.mock("qrcode", () => ({
  default: {
    toDataURL: (text: string) => {
      enroll.drawn.push(text)
      return Promise.resolve("data:image/png;base64,")
    },
  },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const he = (key: string) => translate("he", key)

let container: HTMLDivElement
let root: Root
let secret = ""
let query = ""
let codes: string[] = []
const enrolled = vi.fn()

beforeEach(() => {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => BASE32[b % 32]).join("")
  query = `?secret=${secret}&issuer=Maane&digits=6&period=30`
  codes = Array.from({ length: 10 }, () => crypto.randomUUID().slice(0, 11))
  enroll.drawn = []
  enroll.enable.mockReset()
  enroll.verifyTotp.mockReset()
  enroll.revokeOtherSessions.mockReset()
  enrolled.mockReset()
  enroll.enable.mockResolvedValue({
    data: { totpURI: `otpauth://totp/Maane:first.admin%40maane.invalid${query}`, backupCodes: codes },
    error: null,
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function start() {
  await act(async () => {
    root.render(
      <I18nProvider>
        <TotpStep known={crypto.randomUUID()} onEnrolled={enrolled} retryDelayMs={0} />
      </I18nProvider>,
    )
  })
  await vi.waitFor(() => expect(container.querySelector("input[autocomplete=one-time-code]")).not.toBeNull())
}

async function typeCode(code: string) {
  const input = container.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]") as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(input, code)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("two-factor enrollment", () => {
  it("draws the QR code with the username and shows Better Auth's key, starting once", async () => {
    await start()
    await vi.waitFor(() => expect(enroll.drawn).toEqual([`otpauth://totp/Maane:first.admin${query}`]))
    expect(container.querySelector("[data-testid=totp-secret]")?.textContent).toContain(secret)
    expect(enroll.enable).toHaveBeenCalledTimes(1)
  })

  it("explains a wrong code and clears it", async () => {
    enroll.verifyTotp.mockResolvedValue({ data: null, error: { status: 401, code: "INVALID_CODE" } })
    await start()
    await typeCode("000000")
    await vi.waitFor(() => expect(container.textContent).toContain(he("errors.code.wrongCode")))
    expect(container.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]")?.value).toBe("")
    expect(enroll.revokeOtherSessions).not.toHaveBeenCalled()
    expect(enrolled).not.toHaveBeenCalled()
  })

  it("ends the other sessions, then hands on the backup codes", async () => {
    enroll.verifyTotp.mockResolvedValue({ data: { token: "x" }, error: null })
    enroll.revokeOtherSessions.mockResolvedValue({ data: { status: true }, error: null })
    await start()
    await typeCode("123456")
    await vi.waitFor(() => expect(enrolled).toHaveBeenCalledWith(codes))
    expect(enroll.verifyTotp).toHaveBeenCalledWith({ code: "123456" })
    expect(enroll.revokeOtherSessions).toHaveBeenCalledTimes(1)
  })

  it("offers to try again when ending the other sessions fails three times", async () => {
    enroll.verifyTotp.mockResolvedValue({ data: { token: "x" }, error: null })
    enroll.revokeOtherSessions.mockResolvedValue({ data: null, error: { status: 500 } })
    await start()
    await typeCode("123456")
    await vi.waitFor(() => expect(container.textContent).toContain(he("enroll.signOutOthersFailed")))
    expect(enroll.revokeOtherSessions).toHaveBeenCalledTimes(SIGN_OUT_OTHERS_TRIES)
    expect(enrolled).not.toHaveBeenCalled()

    enroll.revokeOtherSessions.mockResolvedValue({ data: { status: true }, error: null })
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === he("enroll.signOutOthersRetry"),
    )
    await act(async () => retry?.click())
    await vi.waitFor(() => expect(enrolled).toHaveBeenCalledWith(codes))
  })
})

describe("enrollment after it is left", () => {
  it("does not send another account-wide mutation after the old enrollment unmounts", async () => {
    let release: (value: unknown) => void = () => {}
    let identity = "A"
    const sentBy: string[] = []
    enroll.verifyTotp.mockResolvedValue({ data: {}, error: null })
    enroll.revokeOtherSessions.mockImplementation(() => {
      sentBy.push(identity)
      if (sentBy.length === 1)
        return new Promise((resolve) => {
          release = resolve
        })
      return Promise.resolve({ data: { status: true }, error: null })
    })
    await start()
    await typeCode("123456")
    await vi.waitFor(() => expect(sentBy).toEqual(["A"]))
    await act(async () => root.render(null))
    identity = "B"
    await act(async () => release({ data: null, error: { status: 500 } }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sentBy).toEqual(["A"])
    expect(enrolled).not.toHaveBeenCalled()
  })
})
