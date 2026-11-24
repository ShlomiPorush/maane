import { Lock } from "lucide-react"
import type { ReactNode } from "react"
import { errorText } from "../api/errors.ts"
import { useI18n } from "../i18n/i18n.tsx"

export function Loading({ label }: { label: string }) {
  return (
    <div className="ui-loading" role="status">
      <span className="ui-spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  )
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="ui-empty">
      <b>{title}</b>
      {hint ? <span>{hint}</span> : null}
    </div>
  )
}

export function ErrorState({ title, error, onRetry }: { title: string; error: unknown; onRetry?: () => void }) {
  const { t } = useI18n()
  return (
    <div className="ui-empty ui-error" role="alert">
      <b>{title}</b>
      <span>{errorText(t, error)}</span>
      {onRetry ? (
        <button type="button" className="ui-btn ui-btn-sm" onClick={onRetry}>
          {t("common.tryAgain")}
        </button>
      ) : null}
    </div>
  )
}

export function Locked({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-locked">
      <Lock className="ui-locked-icon" aria-hidden="true" />
      <div>
        <b>{title}</b>
        <p>{children}</p>
      </div>
      {action}
    </div>
  )
}

export function Banner({
  tone,
  title,
  children,
  action,
}: {
  tone: "info" | "ok" | "warn" | "fail"
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className={`ui-banner ui-banner-${tone}`} role={tone === "fail" ? "alert" : "status"}>
      <div>
        <b>{title}</b>
        {children ? <p>{children}</p> : null}
      </div>
      {action}
    </div>
  )
}

export function StaleNote({ failed }: { failed: boolean }) {
  const { t } = useI18n()
  if (!failed) return null
  return (
    <p className="ui-stale-note" role="status">
      {t("errors.refreshFailed")}
    </p>
  )
}
