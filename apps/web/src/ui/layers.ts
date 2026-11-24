export type LayerOptions = {
  root: HTMLElement
  close: () => void
  noHistory?: boolean
  initialFocus?: () => HTMLElement | null
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

function tabbables(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (element) => element.tabIndex >= 0 && !element.closest("[hidden], [inert]"),
  )
}

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

// With the page's own idx, Back over unsaved changes becomes history.go(0), a reload, not the Leave question.
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

export function openLayer(options: LayerOptions): () => void {
  const layer: Layer = { ...options, id: nextId++, opener: document.activeElement }
  stack.push(layer)
  syncInert()
  if (!layer.noHistory) pushEntry()
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
    requestAnimationFrame(() => {
      if (needsEntry()) pushEntry()
    })
  })
}
