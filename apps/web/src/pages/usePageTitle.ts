import { useEffect } from "react"
import { useI18n } from "../i18n/i18n.tsx"

export function usePageTitle(title: string): void {
  const { t } = useI18n()
  useEffect(() => {
    document.title = `${title} · ${t("app.name")}`
  }, [title, t])
}
