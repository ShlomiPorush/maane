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
  side: "top" | "bottom"
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

  useEffect(() => {
    if (pathname !== openedOn.current) closeRef.current()
  }, [pathname])

  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect()
    const panel = panelRef.current
    if (!rect || !panel) return
    const width = panel.offsetWidth
    const rtl = dir === "rtl"
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

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    return openLayer({
      root,
      close: () => closeRef.current(),
      initialFocus: () => root.querySelector<HTMLElement>(ITEMS),
    })
  }, [])

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
              // biome-ignore lint/a11y/useSemanticElements: the radio items form a group of the menu
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
