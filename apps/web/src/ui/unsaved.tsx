// Unsaved changes are protected (v3 SV-1, DS-9). A page or a dialog registers how many changes it
// holds and which moves keep them. One router blocker asks before a move would drop them (links,
// Back and Forward, which are undone while the question is open), and the browser asks before the
// tab closes or reloads. A leave the router does not see (signing out) asks the same question through
// useConfirmLeave, and drops nothing itself: the caller clears the changes once the leave worked.

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { type Location, useBeforeUnload, useBlocker } from "react-router"
import { useI18n } from "../i18n/i18n.tsx"
import { confirmDialog } from "./confirm.tsx"

export type UnsavedGuard = {
  count: number
  /** "leave" for a page with a save bar, "discard" for a dialog with typed changes. */
  kind: "leave" | "discard"
  /** True when a move keeps the changes (it stays inside the page or dialog). */
  keeps?: (next: Location, current: Location) => boolean
}

type Registry = {
  set(id: string, guard: UnsavedGuard | null): void
  clear(): void
  /** Asks before a leave the router does not see; true to go on. Nothing is dropped here. */
  confirmLeave(): Promise<boolean>
}
const UnsavedContext = createContext<Registry | null>(null)

export function UnsavedProvider({ children }: { children: ReactNode }) {
  const { t, tc } = useI18n()
  const guards = useRef(new Map<string, UnsavedGuard>())
  const [total, setTotal] = useState(0)

  const recount = useCallback(() => {
    let sum = 0
    for (const guard of guards.current.values()) sum += guard.count
    setTotal(sum)
  }, [])

  /** The one question for every leave: "Leave without saving?", or "Discard your changes?" for dialogs only. */
  const ask = useCallback(
    (dropping: UnsavedGuard[]) => {
      const count = dropping.reduce((sum, guard) => sum + guard.count, 0)
      const discard = dropping.every((guard) => guard.kind === "discard")
      return confirmDialog(
        discard
          ? {
              title: t("unsaved.discardTitle"),
              message: t("unsaved.discardMessage"),
              confirmText: t("unsaved.discard"),
              cancelText: t("unsaved.keepEditing"),
              focusCancel: true,
              noHistory: true,
            }
          : {
              title: t("unsaved.leaveTitle"),
              message: tc("unsaved.leaveMessage", count),
              confirmText: t("unsaved.leave"),
              cancelText: t("unsaved.stay"),
              focusCancel: true,
              noHistory: true,
            },
      )
    },
    [t, tc],
  )

  const registry = useMemo<Registry>(
    () => ({
      set(id, guard) {
        if (guard && guard.count > 0) guards.current.set(id, guard)
        else guards.current.delete(id)
        recount()
      },
      clear() {
        guards.current.clear()
        recount()
      },
      async confirmLeave() {
        const dropping = [...guards.current.values()].filter((guard) => guard.count > 0)
        return dropping.length === 0 || ask(dropping)
      },
    }),
    [recount, ask],
  )

  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (currentLocation.pathname === nextLocation.pathname && currentLocation.search === nextLocation.search)
      return false
    for (const guard of guards.current.values()) {
      if (guard.count > 0 && !guard.keeps?.(nextLocation, currentLocation)) return true
    }
    return false
  })

  useEffect(() => {
    if (blocker.state !== "blocked") return
    const dropping = [...guards.current.values()].filter((guard) => guard.count > 0)
    void ask(dropping).then((leave) => {
      if (leave) {
        guards.current.clear()
        recount()
        blocker.proceed?.()
      } else {
        blocker.reset?.()
      }
    })
  }, [blocker, ask, recount])

  useBeforeUnload(
    useCallback(
      (event: BeforeUnloadEvent) => {
        if (total > 0) {
          event.preventDefault()
          event.returnValue = ""
        }
      },
      [total],
    ),
  )

  return <UnsavedContext.Provider value={registry}>{children}</UnsavedContext.Provider>
}

/** Registers the changes a page or dialog holds while it is mounted. */
export function useUnsaved(id: string, guard: UnsavedGuard): void {
  const registry = useContext(UnsavedContext)
  const keepsRef = useRef(guard.keeps)
  keepsRef.current = guard.keeps
  useEffect(() => {
    registry?.set(id, {
      count: guard.count,
      kind: guard.kind,
      keeps: (next, current) => keepsRef.current?.(next, current) ?? false,
    })
  }, [registry, id, guard.count, guard.kind])
  useEffect(() => () => registry?.set(id, null), [registry, id])
}

/** Drops every registered change: used when the session ended and the app must leave at once. */
export function useClearUnsaved(): () => void {
  const registry = useContext(UnsavedContext)
  return useCallback(() => registry?.clear(), [registry])
}

/** Asks about unsaved changes before a leave the router does not see, such as signing out (SV-1). */
export function useConfirmLeave(): () => Promise<boolean> {
  const registry = useContext(UnsavedContext)
  return useCallback(() => registry?.confirmLeave() ?? Promise.resolve(true), [registry])
}
