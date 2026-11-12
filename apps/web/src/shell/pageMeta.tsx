// Each page names itself: the browser tab title ("Users · Maane"), the crumbs in the top bar and
// the page label in the phone top bar (v3 NL-3, NL-5). A page with sections (Settings) adds the open
// section after its title: "Settings › General" in the trail, "Settings · General · Maane" in the tab.

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react"
import { useI18n } from "../i18n/i18n.tsx"

export type Crumb = { label: string; to?: string }
/** The open section of a page: its name, and the page's own address for the title's link back. */
export type Tail = { label: string; pageTo: string }
type Meta = { title: string; crumbs: Crumb[]; tail?: Tail }
type MetaContext = { meta: Meta; setMeta(meta: Meta): void }

const PageMetaContext = createContext<MetaContext | null>(null)

export function PageMetaProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta>({ title: "", crumbs: [] })
  const value = useMemo(() => ({ meta, setMeta }), [meta])
  return <PageMetaContext.Provider value={value}>{children}</PageMetaContext.Provider>
}

export function usePageMeta(title: string, crumbs: Crumb[] = [], tail?: Tail): void {
  const context = useContext(PageMetaContext)
  const { t } = useI18n()
  const key = JSON.stringify([crumbs, tail])
  // biome-ignore lint/correctness/useExhaustiveDependencies: crumbs and the tail are compared by their JSON key
  useEffect(() => {
    document.title = [title, tail?.label, t("app.name")].filter(Boolean).join(" · ")
    context?.setMeta({ title, crumbs, tail })
  }, [title, key, t])
}

export function useCurrentMeta(): Meta {
  return useContext(PageMetaContext)?.meta ?? { title: "", crumbs: [] }
}
