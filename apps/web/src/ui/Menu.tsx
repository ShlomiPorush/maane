// The one menu builder (v3 MP-7, DS-24; the shape of n8n-ops' account menu, a Radix DropdownMenu, rebuilt on
// Maane's layer owner). A menu is a layer of ui/layers.ts: Escape and Back close it and stay on the page, the
// focus moves to its first item and back to its button, and the page behind is inert. It opens beside its
// button, clamped 8px inside the screen, and a press beside it closes it. Up and Down move through the items
// and wrap, Home and End jump, Tab closes it; choosing an item closes the menu first, then runs the item. A
// link opens its page in place of the menu's history entry and the menu closes once the move is made, as the
// More sheet does: so no stale step is left behind, and Stay in the Leave question keeps the menu open.
// popups.guard.test.ts fails on a menu made anywhere else.

import { Check } from "lucide-react"
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { useLocation, useNavigate } from "react-router"
import { useI18n } from "../i18n/i18n.tsx"
import { openLayer } from "./layers.ts"

export type MenuEntry =
  | { kind: "item"; label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean }
  | { kind: "link"; label: string; icon?: ReactNode; to: string }
  | { kind: "radios"; label: string; options: MenuRadio[] }
  | { kind: "separator" }
  | { kind: "header"; content: ReactNode }

export type MenuRadio = {
  label: string
  icon?: ReactNode
  /** The language of the label, when it is not the page's (a language's own name). */
  lang?: string
  checked: boolean
  onSelect: () => void
}

const ITEMS = '[role="menuitem"], [role="menuitemradio"]'
const GAP = 6
const EDGE = 8

export function Menu({
  anchor,
  label,
  entries,
  side,
  align,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>
  label: string
  entries: MenuEntry[]
  /** Above the button (the sidebar foot) or under it (the phone top bar). */
  side: "top" | "bottom"
  /** Which edge of the button the menu lines up with, in the reading direction. */
  align: "start" | "end"
  onClose: () => void
}) {
  const { dir } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const pressedOutside = useRef(false)
  const [place, setPlace] = useState<CSSProperties>({ visibility: "hidden" })
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const openedOn = useRef(pathname)

  // A link took the menu's history entry: the menu closes once its page shows.
  useEffect(() => {
    if (pathname !== openedOn.current) closeRef.current()
  }, [pathname])

  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect()
    const panel = panelRef.current
    if (!rect || !panel) return
    const width = panel.offsetWidth
    const rtl = dir === "rtl"
    // The start edge of the menu, measured from the start edge of the screen in the reading direction.
    const buttonStart = rtl ? window.innerWidth - rect.right : rect.left
    const buttonEnd = rtl ? window.innerWidth - rect.left : rect.right
    const wanted = align === "start" ? buttonStart : buttonEnd - width
    const start = Math.max(EDGE, Math.min(wanted, window.innerWidth - width - EDGE))
    const vertical =
      side === "top"
        ? { bottom: Math.max(EDGE, window.innerHeight - rect.top + GAP), maxHeight: rect.top - GAP - EDGE }
        : { top: rect.bottom + GAP, maxHeight: window.innerHeight - rect.bottom - GAP - EDGE }
    setPlace({ ...vertical, insetInlineStart: start })
  }, [anchor, dir, side, align])

  // The press beside the menu is the layer's root, portalled into <body> as the dialog builder does.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    return openLayer({
      root,
      close: () => closeRef.current(),
      initialFocus: () => root.querySelector<HTMLElement>(ITEMS),
    })
  }, [])

  // The button moves to the other bar at 760px: the menu that belongs to it closes.
  useEffect(() => {
    const media = matchMedia("(max-width: 760px)")
    const onChange = () => closeRef.current()
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ITEMS))
    const at = items.indexOf(document.activeElement as HTMLElement)
    const go = (index: number) => {
      event.preventDefault()
      items[(index + items.length) % items.length]?.focus()
    }
    if (event.key === "ArrowDown") go(at + 1)
    else if (event.key === "ArrowUp") go(at <= 0 ? items.length - 1 : at - 1)
    else if (event.key === "Home") go(0)
    else if (event.key === "End") go(items.length - 1)
    else if (event.key === "Tab") {
      event.preventDefault()
      closeRef.current()
    }
  }

  const choose = (run: () => void) => {
    closeRef.current()
    run()
  }
  const follow = (to: string) => {
    if (to === pathname) closeRef.current()
    else navigate(to, { replace: true })
  }

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: a press beside the menu closes it; Escape does the same by keyboard
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above
    <div
      ref={rootRef}
      className="ui-menu-backdrop"
      data-layer="menu"
      onMouseDown={(event) => {
        pressedOutside.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && (pressedOutside.current || event.detail === 0)) closeRef.current()
        pressedOutside.current = false
      }}
    >
      <div
        ref={panelRef}
        className="ui-menu"
        role="menu"
        aria-label={label}
        data-layer-panel=""
        style={place}
        onKeyDown={onKeyDown}
      >
        {entries.map((entry, index) => {
          const key = `${entry.kind}-${index}`
          if (entry.kind === "separator") return <hr key={key} className="ui-menu-sep" />
          if (entry.kind === "header")
            return (
              <div key={key} className="ui-menu-header">
                {entry.content}
              </div>
            )
          if (entry.kind === "radios")
            return (
              // A named group of choices, one of them checked (the theme). WAI-ARIA's menu pattern groups
              // menuitemradio items with role group; a fieldset is not allowed inside a menu.
              // biome-ignore lint/a11y/useSemanticElements: see above
              <div key={key} role="group" aria-label={entry.label}>
                <div className="ui-menu-label" aria-hidden="true">
                  {entry.label}
                </div>
                {entry.options.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    role="menuitemradio"
                    aria-checked={option.checked}
                    lang={option.lang}
                    tabIndex={-1}
                    className="ui-menu-item"
                    onClick={() => choose(option.onSelect)}
                  >
                    {option.icon}
                    <span>{option.label}</span>
                    {option.checked ? <Check className="ui-menu-check" aria-hidden="true" /> : null}
                  </button>
                ))}
              </div>
            )
          return (
            <button
              key={key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={entry.kind === "item" && entry.danger ? "ui-menu-item is-danger" : "ui-menu-item"}
              onClick={() => (entry.kind === "link" ? follow(entry.to) : choose(entry.onSelect))}
            >
              {entry.icon}
              <span>{entry.label}</span>
            </button>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
