// One owner for every layer over the page (v3 DS-8, DS-10, DS-11). Escape and the browser Back
// button close only the top layer, through its own close function, and stay on the page. While a
// layer is open the page holds one extra history entry at the same URL; closing by hand takes it
// back, so the next Back really leaves. Everything except the top layer and the toast is inert, the
// focus moves into the layer and returns to the control that opened it. In a modal layer (a dialog) Tab and
// Shift+Tab stay inside, wrapping at its ends, and a Tab from outside (the toast) comes back in (W3C APG modal
// dialog pattern); a menu handles Tab itself.

export type LayerOptions = {
  /**
   * The layer's root element: its builder portals it straight into <body>, outside any stacking
   * context (DS-15), and React owns it, so StrictMode's second effect run finds it still there.
   */
  root: HTMLElement
  /** Closes the layer the way its X or Cancel does (it may ask first). */
  close: () => void
  /** The layer has its own history entry already (an item opened by URL) or must not add one. */
  noHistory?: boolean
  /** Where the focus goes on open; default: first field, else primary button, else the panel. */
  initialFocus?: () => HTMLElement | null
  /** A modal dialog: Tab and Shift+Tab stay inside it. */
  modal?: boolean
}

type Layer = LayerOptions & { id: number; opener: Element | null }

const stack: Layer[] = []
let nextId = 1
let holdsEntry = false
let ignorePops = 0

const touchOnly = () => typeof matchMedia === "function" && matchMedia("(hover: none) and (pointer: coarse)").matches

let inertNow = new Set<HTMLElement>()

function syncInert(): void {
  const top = stack.at(-1)
  const want = new Set<HTMLElement>()
  if (top) {
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof HTMLElement) || child.tagName === "SCRIPT") continue
      if (child !== top.root && child.dataset.layerKeep !== "true") want.add(child)
    }
  }
  for (const element of inertNow) if (!want.has(element)) element.inert = false
  for (const element of want) element.inert = true
  inertNow = want
  // The page behind a layer stays still (DS-11).
  document.documentElement.classList.toggle("ui-layer-on", stack.length > 0)
}

function focusInto(layer: Layer): void {
  const wanted = layer.initialFocus?.()
  if (wanted) {
    wanted.focus({ preventScroll: true })
    return
  }
  const panel = layer.root.querySelector<HTMLElement>("[data-layer-panel]") ?? layer.root
  const field = touchOnly()
    ? null
    : panel.querySelector<HTMLElement>(
        "input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])",
      )
  const primary = panel.querySelector<HTMLElement>(
    "[data-autofocus], .ui-btn-primary:not([disabled]), .ui-btn-danger-solid:not([disabled])",
  )
  const target = field ?? primary ?? panel
  if (target === panel && !panel.hasAttribute("tabindex")) panel.tabIndex = -1
  target.focus({ preventScroll: true })
}

const TABBABLE =
  "a[href], area[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), " +
  "textarea:not([disabled]), iframe, summary, [contenteditable]:not([contenteditable=false]), [tabindex]"

/** The controls Tab reaches in a panel, in order. No layout check: what a layer hides, it does not render. */
function tabbables(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (element) => element.tabIndex >= 0 && !element.closest("[hidden], [inert]"),
  )
}

/** Keeps Tab inside a modal top layer: wraps at its ends and brings a focus from outside back in. */
function trapTab(event: KeyboardEvent): void {
  const top = stack.at(-1)
  if (!top?.modal) return
  const panel = top.root.querySelector<HTMLElement>("[data-layer-panel]") ?? top.root
  const items = tabbables(panel)
  const first = items[0]
  const last = items.at(-1)
  const active = document.activeElement
  const inside = active instanceof Node && panel.contains(active)
  let target: HTMLElement | undefined
  if (!first || !last) target = panel
  else if (!inside) target = event.shiftKey ? last : first
  else if (event.shiftKey && (active === first || active === panel)) target = last
  else if (!event.shiftKey && active === last) target = first
  if (!target) return
  event.preventDefault()
  if (target === panel && !panel.hasAttribute("tabindex")) panel.tabIndex = -1
  target.focus({ preventScroll: true })
}

/**
 * The layer's entry is one step after the page's. React Router numbers its entries (`idx`) to tell Back from
 * Forward and to block a move that would drop unsaved changes; a link that replaces this entry (More, the account
 * menu, the bell) keeps its number, so a copy of the page's own would leave two entries with one number, and Back
 * from the opened page would leave without the Leave question.
 */
function pushEntry(): void {
  if (holdsEntry) return
  const state = (history.state ?? {}) as { idx?: unknown }
  const idx = typeof state.idx === "number" ? { idx: state.idx + 1 } : {}
  history.pushState({ ...state, ...idx, maaneLayer: true }, "")
  holdsEntry = true
}

function needsEntry(): boolean {
  return stack.some((layer) => !layer.noHistory)
}

let releaseQueued = false

/**
 * Closed by hand: takes back the extra entry, so the next Back leaves the page. When a navigation
 * already left that entry (a link inside the layer), there is nothing to take back.
 *
 * Decided in a microtask, so a layer that opens in the same synchronous run as the close keeps the
 * entry: StrictMode's second effect run in development (an effect, its cleanup and the effect again)
 * and a synchronous swap of one layer for another. Two cases are not covered, and failed before
 * this deferral too: a layer opened from a later microtask or task, after the release already went
 * back, is left without an entry of its own; and a Back that races a close can go one step too far.
 */
function releaseEntry(): void {
  if (releaseQueued) return
  releaseQueued = true
  queueMicrotask(() => {
    releaseQueued = false
    if (!holdsEntry || needsEntry()) return
    holdsEntry = false
    if ((history.state as { maaneLayer?: boolean } | null)?.maaneLayer) {
      ignorePops++
      history.back()
    }
  })
}

/** Registers an open layer; returns its removal. */
export function openLayer(options: LayerOptions): () => void {
  const layer: Layer = { ...options, id: nextId++, opener: document.activeElement }
  stack.push(layer)
  syncInert()
  if (!layer.noHistory) pushEntry()
  // In the next frame, unless the focus is inside the layer already: typing that started in that frame (a fast
  // typist, a password manager) keeps its field instead of landing in the first one.
  requestAnimationFrame(() => {
    if (stack.includes(layer) && !layer.root.contains(document.activeElement)) focusInto(layer)
  })
  return () => {
    const index = stack.indexOf(layer)
    if (index === -1) return
    stack.splice(index, 1)
    syncInert()
    if (holdsEntry && !needsEntry()) releaseEntry()
    const opener = layer.opener
    const below = stack.at(-1)
    requestAnimationFrame(() => {
      // A layer on top that holds the focus keeps it: a close never pulls it out of the layer the owner works in
      // (StrictMode's second run of the same dialog, or a picker closed by a click into its dialog).
      const top = stack.at(-1)
      if (top?.root.contains(document.activeElement)) return
      if (opener instanceof HTMLElement && opener.isConnected && !opener.closest("[inert]"))
        opener.focus({ preventScroll: true })
      else if (below) focusInto(below)
    })
  }
}

export function topLayerIs(root: HTMLElement | null): boolean {
  return !!root && stack.at(-1)?.root === root
}

export function layerCount(): number {
  return stack.length
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        trapTab(event)
        return
      }
      if (event.key !== "Escape" || !stack.length) return
      const top = stack.at(-1)
      // A native select or an open picker inside the top layer closes itself first.
      if (event.target instanceof HTMLSelectElement) return
      event.preventDefault()
      event.stopPropagation()
      top?.close()
    },
    true,
  )
  window.addEventListener("popstate", () => {
    if (ignorePops > 0) {
      ignorePops--
      return
    }
    if (!holdsEntry) return
    holdsEntry = false
    const top = [...stack].reverse().find((layer) => !layer.noHistory)
    top?.close()
    // A layer that asked first and stayed open, or one below it, still needs its entry.
    requestAnimationFrame(() => {
      if (needsEntry()) pushEntry()
    })
  })
}
