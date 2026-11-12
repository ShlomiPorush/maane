// A modal dialog keeps the keyboard inside (W3C APG modal dialog): Tab from the last control goes to the first,
// Shift+Tab from the first goes to the last, and a Tab from outside (the toast) comes back in. Inside, Tab is left to
// the browser. A layer that is not modal (a menu, which closes on Tab itself) is left alone.

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import { I18nProvider } from "../i18n/i18n.tsx"
import { Dialog } from "./Dialog.tsx"
import { openLayer } from "./layers.ts"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let mounted: Root | null = null

afterEach(async () => {
  const root = mounted
  if (root) await act(async () => root.unmount())
  mounted = null
  document.body.innerHTML = ""
})

const frame = () => act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

function tab(shift = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true })
  ;(document.activeElement ?? document.body).dispatchEvent(event)
  return event
}

describe("modal dialogs keep the focus inside", () => {
  it("wraps Tab and Shift+Tab at the edges and brings the focus back from outside", async () => {
    const keep = document.createElement("div")
    keep.dataset.layerKeep = "true"
    const toast = document.createElement("button")
    keep.append(toast)
    document.body.append(keep)
    const host = document.createElement("div")
    document.body.append(host)
    mounted = createRoot(host)
    await act(async () =>
      mounted?.render(
        <I18nProvider>
          <Dialog
            title="Title"
            size="sm"
            onClose={() => {}}
            foot={
              <button type="button" id="last">
                Last
              </button>
            }
          >
            <button type="button" id="middle">
              Middle
            </button>
            <button type="button" disabled>
              Disabled
            </button>
          </Dialog>
        </I18nProvider>,
      ),
    )
    await frame()
    const first = document.querySelector<HTMLButtonElement>(".ui-dialog-head button") as HTMLButtonElement
    const middle = document.getElementById("middle") as HTMLButtonElement
    const last = document.getElementById("last") as HTMLButtonElement

    last.focus()
    expect(tab().defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)

    first.focus()
    expect(tab(true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)

    middle.focus()
    expect(tab().defaultPrevented).toBe(false)

    toast.focus()
    expect(tab().defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
  })

  it("leaves Tab alone in a layer that is not modal", async () => {
    const root = document.createElement("div")
    const item = document.createElement("button")
    root.append(item)
    document.body.append(root)
    const close = openLayer({ root, close: () => {} })
    item.focus()
    expect(tab().defaultPrevented).toBe(false)
    close()
  })
})
