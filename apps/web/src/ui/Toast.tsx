// The one toast (v3 FB-2, FB-16): bottom end corner (above the tab bar on phones), one at a time
// (a new one replaces the current one), four seconds by default, waits while the pointer or the
// focus is on it and then keeps at least 1.5 seconds. It may carry one action such as Undo; an
// action that returns a promise holds the toast until it settles.

import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useI18n } from "../i18n/i18n.tsx"

export type ToastType = "success" | "error" | "warning" | "info"
export type ToastAction = { label: string; ariaLabel?: string; onAction: () => unknown }
export type ToastOptions = { action?: ToastAction; duration?: number }
type ToastState = { id: number; message: string; type: ToastType; action?: ToastAction; duration: number }

export const TOAST_MS = 4000
export const UNDO_MS = 10_000
const REST_MS = 1500

let emit: ((toast: ToastState) => void) | null = null
let nextId = 1

export function showToast(message: string, type: ToastType = "info", options: ToastOptions = {}): void {
  emit?.({
    id: nextId++,
    message,
    type,
    action: options.action,
    duration: options.duration ?? (options.action ? UNDO_MS : TOAST_MS),
  })
}

const ICONS = { success: CircleCheck, error: CircleAlert, warning: TriangleAlert, info: Info }

export function ToastHost() {
  const { t } = useI18n()
  const [toast, setToast] = useState<ToastState | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const deadline = useRef(0)
  const held = useRef(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const dismiss = useCallback(() => {
    window.clearTimeout(timer.current)
    setToast(null)
    setBusy(false)
  }, [])

  const arm = useCallback(
    (ms: number) => {
      window.clearTimeout(timer.current)
      deadline.current = Date.now() + ms
      if (Number.isFinite(ms)) timer.current = window.setTimeout(dismiss, ms)
    },
    [dismiss],
  )

  useEffect(() => {
    emit = (next) => {
      // The keyboard in the toast being replaced moves to the new one.
      const hadFocus = !!boxRef.current?.contains(document.activeElement)
      setBusy(false)
      setToast(next)
      held.current = false
      arm(next.duration)
      if (hadFocus) requestAnimationFrame(() => boxRef.current?.querySelector<HTMLElement>("button")?.focus())
    }
    return () => {
      emit = null
      window.clearTimeout(timer.current)
    }
  }, [arm])

  const hold = () => {
    if (held.current || !toast) return
    held.current = true
    window.clearTimeout(timer.current)
  }
  const release = () => {
    if (!held.current || !toast || busy) return
    if (boxRef.current?.matches(":hover") || boxRef.current?.contains(document.activeElement)) return
    held.current = false
    arm(Math.max(deadline.current - Date.now(), REST_MS))
  }

  // The wrapper stays in <body> while the host lives, outside every layer and never made inert
  // (layers.ts skips data-layer-keep). React owns it, so StrictMode's second effect run in
  // development keeps rendering into the element that is in the page.
  const Icon = toast ? ICONS[toast.type] : null
  return createPortal(
    <div data-layer-keep="true">
      {toast && Icon ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: the toast is a status or alert region; pointer and focus only pause its timer (v3 FB-2)
        <div
          ref={boxRef}
          key={toast.id}
          className={`ui-toast ui-toast-${toast.type}`}
          role={toast.type === "error" ? "alert" : "status"}
          onMouseEnter={hold}
          onMouseLeave={release}
          onFocus={hold}
          onBlur={() => requestAnimationFrame(release)}
        >
          <Icon className="ui-toast-icon" aria-hidden="true" />
          <p>{toast.message}</p>
          {toast.action ? (
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-toast-action"
              aria-label={toast.action.ariaLabel}
              aria-disabled={busy || undefined}
              onClick={async () => {
                if (busy || !toast.action) return
                const result = toast.action.onAction()
                if (result instanceof Promise) {
                  setBusy(true)
                  hold()
                  try {
                    await result
                  } finally {
                    setBusy(false)
                  }
                  // A toast the action showed meanwhile takes over; otherwise this one goes.
                  setToast((current) => (current?.id === toast.id ? null : current))
                } else {
                  dismiss()
                }
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="ui-icon-btn"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={dismiss}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  )
}
