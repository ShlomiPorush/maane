// An address that names no page: it says so and leads home; the address stays as typed.

import { Link } from "react-router"
import { useI18n } from "../i18n/i18n.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"

export function NotFoundPage() {
  const { t } = useI18n()
  usePageMeta(t("notFound.title"))
  return (
    <div className="ui-page">
      <div className="ui-panel">
        <div className="ui-empty">
          <b>{t("notFound.title")}</b>
          <span>{t("notFound.hint")}</span>
          <Link to="/" className="ui-btn">
            {t("notFound.home")}
          </Link>
        </div>
      </div>
    </div>
  )
}
