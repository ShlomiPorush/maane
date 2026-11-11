// An admin page opened by someone who is not an admin: the page stays and says why it is locked (v3 principle
// "locked, not hidden"). The server refuses these reads and writes on its own; this only explains.

import type { ReactNode } from "react"
import { Link } from "react-router"
import { useI18n } from "../i18n/i18n.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { useMe } from "../shell/session.ts"
import { Locked } from "../ui/states.tsx"

export function AdminOnly({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n()
  const me = useMe()
  if (me.data?.role === "admin") return children
  return (
    <LockedPage title={title} home={t("notFound.home")} text={t("adminOnly.text")} heading={t("adminOnly.title")} />
  )
}

function LockedPage({ title, heading, text, home }: { title: string; heading: string; text: string; home: string }) {
  usePageMeta(title)
  return (
    <div className="ui-page">
      <Locked
        title={heading}
        action={
          <Link to="/" className="ui-btn">
            {home}
          </Link>
        }
      >
        {text}
      </Locked>
    </div>
  )
}
