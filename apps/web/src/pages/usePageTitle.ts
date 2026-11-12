import { useEffect } from "react"
import { useI18n } from "../i18n/i18n.tsx"

/** The browser tab title of a page outside the shell (sign-in, setup, two-factor). */
export function usePageTitle(title: string): void {
  const { t } = useI18n()
  useEffect(() => {
    document.title = `${title} · ${t("app.name")}`
  }, [title, t])
}
