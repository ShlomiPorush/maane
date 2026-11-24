import type { LucideIcon } from "lucide-react"
import { createContext, type ReactNode, useContext, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "react-router"
import { navPageFor } from "./navigation.ts"

type Chrome = { actionsSlot: HTMLElement | null }

export const ChromeContext = createContext<Chrome>({ actionsSlot: null })

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

export const TOP_BAR = "(min-width: 761px)"
export const useTopBar = () => useMediaQuery(TOP_BAR)

export function PageActions({ children }: { children: ReactNode }) {
  const { actionsSlot } = useContext(ChromeContext)
  const wide = useTopBar()
  if (wide && actionsSlot) return createPortal(children, actionsSlot)
  return wide ? null : <div className="ui-page-actions">{children}</div>
}

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
  titleDir?: "auto"
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

function Description({ value }: { value: ReactNode }) {
  if (!value) return null
  return typeof value === "string" ? <p className="ui-page-desc">{value}</p> : value
}
