// Light, dark or follow the system. A preference of this browser (localStorage), applied before the
// first paint by public/boot.js and here when it changes.

import { useCallback, useEffect, useState } from "react"

export type Theme = "light" | "dark" | "system"
export const THEMES: readonly Theme[] = ["light", "dark", "system"]
const KEY = "maane.theme"

function readTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY)
    return value === "light" || value === "dark" ? value : "system"
  } catch {
    return "system"
  }
}

function apply(theme: Theme): void {
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.classList.toggle("dark", dark)
}

export function useTheme(): [Theme, (theme: Theme) => void, boolean] {
  const [theme, setThemeState] = useState<Theme>(readTheme)
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  useEffect(() => {
    apply(theme)
    setDark(document.documentElement.classList.contains("dark"))
    if (theme !== "system") return
    const media = matchMedia("(prefers-color-scheme: dark)")
    const follow = () => {
      apply("system")
      setDark(media.matches)
    }
    media.addEventListener("change", follow)
    return () => media.removeEventListener("change", follow)
  }, [theme])
  // Other tabs and the theme buttons stay in step.
  useEffect(() => {
    const sync = (event: StorageEvent | Event) => {
      if (event instanceof StorageEvent && event.key !== KEY) return
      setThemeState(readTheme())
    }
    window.addEventListener("storage", sync)
    window.addEventListener("maane-theme", sync)
    return () => {
      window.removeEventListener("storage", sync)
      window.removeEventListener("maane-theme", sync)
    }
  }, [])
  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // Storage blocked: the theme still applies to this page.
    }
    setThemeState(next)
    window.dispatchEvent(new Event("maane-theme"))
  }, [])
  return [theme, setTheme, dark]
}
