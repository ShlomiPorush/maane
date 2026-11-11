// The sidebar folds into the 72px icon rail and remembers it in this browser (v3 NL-7; n8n-ops shell.tsx
// useNavFolded). public/boot.js applies the choice before the page draws, so a folded sidebar never flashes
// open. Ctrl+B (Cmd+B on a Mac) folds and unfolds it where the full sidebar exists, above 1100px.

import { useCallback, useEffect, useState } from "react"

export const NAV_KEY = "maane.nav"
export const WIDE_SIDEBAR = "(min-width: 1101px)"

const root = () => document.documentElement

export function isNavFolded(): boolean {
  return root().dataset.nav === "rail"
}

export function setNavFolded(folded: boolean): void {
  if (folded) root().dataset.nav = "rail"
  else delete root().dataset.nav
  try {
    localStorage.setItem(NAV_KEY, folded ? "rail" : "side")
  } catch {
    // Storage blocked: the choice lasts for this visit only.
  }
}

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform)

export function useNavFolded() {
  const [folded, setFolded] = useState(isNavFolded)
  const toggle = useCallback(() => {
    const next = !isNavFolded()
    setNavFolded(next)
    setFolded(next)
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "b" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (!matchMedia(WIDE_SIDEBAR).matches || root().classList.contains("ui-layer-on")) return
      event.preventDefault()
      toggle()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [toggle])
  return { folded, toggle }
}
