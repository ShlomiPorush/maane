// What a page hands to the shell around it (v3 NL-6, NL-14; copied from n8n-ops app/chrome.tsx and
// components/kit.tsx PageHead). From 761px the page's actions move up into the top bar beside the
// page title, and the page draws its own name large under the bar, hidden from assistive technology:
// the one h1 is the title in the top bar. Up to 760px the page keeps its h1 with the main action on
// the same line (NL-14), and the top bar names the page in small type above nothing else.

import type { LucideIcon } from "lucide-react"
import { createContext, type ReactNode, useContext, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "react-router"
import { navPageFor } from "./navigation.ts"

type Chrome = { actionsSlot: HTMLElement | null }

export const ChromeContext = createContext<Chrome>({ actionsSlot: null })

/** Whether a media query matches, kept up to date. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches)
  useEffect(() => {
    const media = matchMedia(query)
    const onChange = () => setMatches(media.matches)
    onChange()
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [query])
  return matches
}

/** The top bar exists from 761px; below that the page keeps its own title row. */
export const TOP_BAR = "(min-width: 761px)"
export const useTopBar = () => useMediaQuery(TOP_BAR)

/**
 * The page's actions: moved into the top bar on wide screens, kept on the title row on a phone. The
 * elements are the page's own, rendered once in one place, so their handlers and state stay as they are.
 */
export function PageActions({ children }: { children: ReactNode }) {
  const { actionsSlot } = useContext(ChromeContext)
  const wide = useTopBar()
  if (wide && actionsSlot) return createPortal(children, actionsSlot)
  return wide ? null : <div className="ui-page-actions">{children}</div>
}

/**
 * The head of a page. Wide: the page's navigation icon in a tile, its name large and its description;
 * the name is drawn only (the top bar holds the h1). Phone: the h1 and the main action on one line,
 * the description under them.
 */
export function PageHead({
  title,
  description,
  actions,
  titleDir,
  icon,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  /** "auto" for a title the user wrote (a project name). */
  titleDir?: "auto"
  /** The icon of a page outside the navigation (Account); a page in it shows its navigation icon. */
  icon?: LucideIcon
}) {
  const wide = useTopBar()
  const navIcon = navPageFor(useLocation().pathname)?.icon
  const Icon = icon ?? navIcon
  if (wide)
    return (
      <>
        {actions ? <PageActions>{actions}</PageActions> : null}
        <div className="ui-page-head">
          {Icon ? (
            <span className="ui-page-icon" aria-hidden="true">
              <Icon />
            </span>
          ) : null}
          <div className="ui-page-head-text">
            <span className="ui-h1" aria-hidden="true" dir={titleDir}>
              {title}
            </span>
            <Description value={description} />
          </div>
        </div>
      </>
    )
  return (
    <div className="ui-page-head">
      <div className="ui-page-head-row">
        <h1 className="ui-h1" dir={titleDir}>
          {title}
        </h1>
        {actions ? <PageActions>{actions}</PageActions> : null}
      </div>
      <Description value={description} />
    </div>
  )
}

/** A plain description is one muted line; a page with more to say there (a project) passes its own element. */
function Description({ value }: { value: ReactNode }) {
  if (!value) return null
  return typeof value === "string" ? <p className="ui-page-desc">{value}</p> : value
}
