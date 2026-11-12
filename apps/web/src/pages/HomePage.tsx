// The home page. Tickets arrive in phase 2; until then it says there are none and where they will come from.

import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { Empty } from "../ui/states.tsx"

export function HomePage() {
  const { t } = useI18n()
  usePageMeta(t("home.title"))
  return (
    <div className="ui-page">
      <PageHead title={t("home.title")} description={t("home.description")} />
      <div className="ui-panel">
        <Empty title={t("home.emptyTitle")} hint={t("home.emptyHint")} />
      </div>
    </div>
  )
}
