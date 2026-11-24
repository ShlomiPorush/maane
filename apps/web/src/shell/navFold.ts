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
  } catch {}
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
