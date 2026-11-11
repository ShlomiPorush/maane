// The one dialog builder (v3 DS-24, DS-16, DS-1 to DS-4, DS-9). Every dialog has a head with its
// title and the shared X, a body that scrolls, its actions in a foot, and a set width. A question
// (role alertdialog) has no X and closes by its Cancel. On a phone every dialog is a bottom sheet
// that opens at four fifths of the screen, grows by exactly the scrolled distance, and closes on a
// pull down past min(120px, a quarter of its height). popups.guard.test.ts fails on a dialog, sheet
// or layer made anywhere else.

import { X } from "lucide-react"
import { type ReactNode, type RefObject, useEffect, useId, useRef } from "react"
import { createPortal } from "react-dom"
import { useI18n } from "../i18n/i18n.tsx"
import { openLayer } from "./layers.ts"

export const DIALOG_SIZES = { sm: 460, md: 680, wide: 1100 } as const
export type DialogSize = keyof typeof DIALOG_SIZES

type Common = {
  title: ReactNode
  /** Required: 460, 680 or 1100px wide, always as high as the content. */
  size: DialogSize
  children: ReactNode
  /** Buttons for the foot; never put Save, Cancel or Close in the scrolling body. */
  foot?: ReactNode
  /** Only for windows without typed input: a click outside closes them (DS-9). */
  backdropClose?: boolean
  /** The dialog already has a history entry of its own (an item opened by URL). */
  noHistory?: boolean
  initialFocus?: () => HTMLElement | null
  bodyClassName?: string
  describedBy?: string
}

export type DialogProps = Common &
  (
    | { role?: "dialog" /** The shared X, Escape, Back and a pull down call it. */; onClose: () => void }
    | {
        role: "alertdialog" /** A question closes by its Cancel: Escape, Back and a pull down call it. */
        onCancel: () => void
      }
  )

const PHONE = "(max-width: 760px)"

export function Dialog(props: DialogProps) {
  const { t } = useI18n()
  const titleId = useId()
  const backdropRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const pressedOnBackdrop = useRef(false)
  const close = props.role === "alertdialog" ? props.onCancel : props.onClose
  const closeRef = useRef(close)
  closeRef.current = close

  // The backdrop is the layer's root. React owns it (a portal into <body>), so StrictMode's second
  // effect run finds the same element still in the page and opens the layer again on it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layer lives as long as the dialog; options are read once at opening (DS-6)
  useEffect(() => {
    const root = backdropRef.current
    if (!root) return
    return openLayer({
      root,
      close: () => closeRef.current(),
      modal: true,
      noHistory: props.noHistory,
      initialFocus: props.initialFocus,
    })
  }, [])
  useSheet(backdropRef, panelRef, closeRef)

  const isQuestion = props.role === "alertdialog"
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is not a control; Escape and the X close the dialog for keyboard users
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above
    <div
      ref={backdropRef}
      className={isQuestion ? "ui-dialog-backdrop ui-confirm" : "ui-dialog-backdrop"}
      data-layer="dialog"
      onMouseDown={(event) => {
        pressedOnBackdrop.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        // Only a press that started on the backdrop counts, so a text selection ending outside keeps the dialog.
        const fromBackdrop = event.target === event.currentTarget && (pressedOnBackdrop.current || event.detail === 0)
        pressedOnBackdrop.current = false
        if (fromBackdrop && props.backdropClose) closeRef.current()
      }}
    >
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is dialog or alertdialog, both modal */}
      <div
        ref={panelRef}
        className={`ui-dialog ui-dialog-fit ui-dialog-${props.size}`}
        role={isQuestion ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.describedBy}
        data-layer-panel=""
      >
        <div className="ui-dialog-head">
          <h3 id={titleId}>{props.title}</h3>
          {!isQuestion && (
            <button
              type="button"
              className="ui-icon-btn"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={() => closeRef.current()}
            >
              <X aria-hidden="true" />
            </button>
          )}
        </div>
        <div className={`ui-dialog-body${props.bodyClassName ? ` ${props.bodyClassName}` : ""}`}>{props.children}</div>
        {props.foot ? <div className="ui-dialog-foot">{props.foot}</div> : null}
      </div>
    </div>,
    document.body,
  )
}

/** Phone sheet: grows with the scroll, drags up by the head, pulls down to close (DS-1, DS-3, DS-4). */
function useSheet(
  backdropRef: RefObject<HTMLDivElement | null>,
  panelRef: RefObject<HTMLDivElement | null>,
  closeRef: RefObject<() => void>,
) {
  useEffect(() => {
    const backdrop = backdropRef.current
    const panel = panelRef.current
    if (!backdrop || !panel) return
    const phone = () => matchMedia(PHONE).matches
    const setHeight = (height: number) => {
      backdrop.classList.add("is-grown")
      panel.style.height = `${Math.min(window.innerHeight, height)}px`
      backdrop.classList.toggle("is-full", panel.offsetHeight >= window.innerHeight - 1)
    }

    // Scrolling first raises the sheet by exactly the scrolled distance, then the content scrolls.
    const onScroll = (event: Event) => {
      if (!phone()) return
      const scroller = event.target
      if (!(scroller instanceof HTMLElement) || !panel.contains(scroller)) return
      const room = window.innerHeight - panel.offsetHeight
      const grow = Math.min(scroller.scrollTop, room)
      if (grow < 1) return
      const height = panel.offsetHeight
      setHeight(height + grow)
      scroller.scrollTop -= panel.offsetHeight - height
    }

    let startY = 0
    let startHeight = 0
    let mode: "none" | "head" | "body" = "none"
    let moved = 0
    const scrolledAbove = (target: EventTarget | null) => {
      for (let node = target as HTMLElement | null; node && node !== panel; node = node.parentElement) {
        if (node.scrollTop > 0) return true
      }
      return false
    }
    const onStart = (event: TouchEvent) => {
      if (!phone() || event.touches.length !== 1) {
        mode = "none"
        return
      }
      const touch = event.touches[0]
      if (!touch) return
      const target = event.target as HTMLElement
      const inHead = !!target.closest(".ui-dialog-head") || touch.clientY - panel.getBoundingClientRect().top < 22
      if (target.closest("button, a, input, textarea, select")) {
        mode = "none"
        return
      }
      mode = inHead ? "head" : scrolledAbove(target) ? "none" : "body"
      startY = touch.clientY
      startHeight = panel.offsetHeight
      moved = 0
      if (inHead) panel.classList.add("is-held")
      panel.style.transition = "none"
    }
    const onMove = (event: TouchEvent) => {
      if (mode === "none") return
      const touch = event.touches[0]
      if (!touch) return
      moved = touch.clientY - startY
      if (moved < 0 && mode === "head") setHeight(startHeight - moved)
      else if (moved > 0) panel.style.transform = `translateY(${moved}px)`
    }
    const onEnd = () => {
      if (mode === "none") return
      panel.classList.remove("is-held")
      panel.style.transition = "transform .2s ease"
      const limit = Math.min(120, panel.offsetHeight / 4)
      if (moved > limit) {
        panel.style.transform = "translateY(100%)"
        window.setTimeout(() => {
          closeRef.current()
          // A dialog that asked first and stayed open springs back.
          if (panel.isConnected) panel.style.transform = ""
        }, 200)
      } else {
        panel.style.transform = ""
      }
      mode = "none"
    }

    backdrop.addEventListener("scroll", onScroll, { capture: true, passive: true })
    panel.addEventListener("touchstart", onStart, { passive: true })
    panel.addEventListener("touchmove", onMove, { passive: true })
    panel.addEventListener("touchend", onEnd, { passive: true })
    panel.addEventListener("touchcancel", onEnd, { passive: true })
    return () => {
      backdrop.removeEventListener("scroll", onScroll, { capture: true })
      panel.removeEventListener("touchstart", onStart)
      panel.removeEventListener("touchmove", onMove)
      panel.removeEventListener("touchend", onEnd)
      panel.removeEventListener("touchcancel", onEnd)
    }
  }, [backdropRef, panelRef, closeRef])
}
