// No area is ever blank (v3 FB-1, FB-3, FB-5, FB-6): loading names what is loading, an empty area says what is
// missing, a failure says what failed and offers Try again, and a control that cannot work is replaced by a locked
// area that says what is missing.

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
  /** A sentence, or an element such as an address isolated left to right. */
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

/** A background refresh that failed keeps what is shown and says so (SV-10). */
export function StaleNote({ failed }: { failed: boolean }) {
  const { t } = useI18n()
  if (!failed) return null
  return (
    <p className="ui-stale-note" role="status">
      {t("errors.refreshFailed")}
    </p>
  )
}
