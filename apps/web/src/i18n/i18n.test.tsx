// The language: Hebrew by default and right to left; the server's default applies only until this browser chooses;
// a filled value is isolated so its direction cannot move the sentence's punctuation.

import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import { FSI, I18nProvider, LANGUAGE_KEY, PDI, translate, useI18n } from "./i18n.tsx"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let api: ReturnType<typeof useI18n> | null = null
function Probe() {
  api = useI18n()
  return null
}

async function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<I18nProvider>{<Probe />}</I18nProvider>))
  return () => act(() => root.unmount())
}

afterEach(() => {
  localStorage.clear()
  api = null
})

describe("i18n", () => {
  it("starts in Hebrew, right to left, without a choice of this browser", async () => {
    const unmount = await mount()
    expect(document.documentElement.lang).toBe("he")
    expect(document.documentElement.dir).toBe("rtl")
    await unmount()
  })

  it("follows the server's default until the browser chooses, then keeps the choice", async () => {
    const unmount = await mount()
    await act(async () => api?.followDefault("en"))
    expect(document.documentElement.dir).toBe("ltr")
    expect(localStorage.getItem(LANGUAGE_KEY)).toBeNull()
    await act(async () => api?.setLanguage("he"))
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe("he")
    await act(async () => api?.followDefault("en"))
    expect(api?.language).toBe("he")
    expect(document.documentElement.dir).toBe("rtl")
    await unmount()
  })

  it("isolates every filled value", () => {
    expect(FSI.codePointAt(0)).toBe(0x2068)
    expect(PDI.codePointAt(0)).toBe(0x2069)
    expect(translate("en", "copy.done", { value: "first.admin" })).toBe(`Copied: ${FSI}first.admin${PDI}`)
  })

  it("falls back to English, then to the key", () => {
    expect(translate("he", "no.such.key")).toBe("no.such.key")
  })
})
