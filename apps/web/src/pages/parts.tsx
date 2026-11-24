import { Lock, RotateCcw } from "lucide-react"
import type { ReactNode } from "react"
import { formatNumber } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"

export function Group({
  id,
  title,
  count,
  extra,
  intro,
  children,
}: {
  id: string
  title: string
  count?: number
  extra?: ReactNode
  intro?: ReactNode
  children: ReactNode
}) {
  return (
    <section id={id} className="ui-panel ui-set-group" aria-labelledby={`${id}-title`}>
      <div className="ui-set-group-head">
        <h2 id={`${id}-title`} className="ui-set-group-title">
          {title}
        </h2>
        {count !== undefined ? <span className="ui-count">{formatNumber(count)}</span> : null}
        {extra ? <div className="ui-set-group-acts">{extra}</div> : null}
      </div>
      {intro ? <p className="ui-set-group-intro">{intro}</p> : null}
      {children}
    </section>
  )
}

export type EnvLock = { variable: string | null }
export type ResetMark = { label: string; onReset: () => void }

export function Row({
  label,
  hint,
  htmlFor,
  lock,
  reset,
  children,
}: {
  label: string
  hint?: ReactNode
  htmlFor?: string
  lock?: EnvLock | null
  reset?: ResetMark | null
  children: ReactNode
}) {
  const { t } = useI18n()
  return (
    <div className={`ui-set-row${lock ? " is-locked" : ""}`}>
      <div className="ui-set-label">
        <span className="ui-set-label-line">
          {htmlFor ? (
            <label htmlFor={htmlFor}>
              <b>{label}</b>
            </label>
          ) : (
            <b>{label}</b>
          )}
          {lock ? (
            <span className="ui-set-pill" title={t("settings.env.tooltip")}>
              <Lock size={12} aria-hidden="true" /> {t("settings.env.pill")}
            </span>
          ) : reset ? (
            <span className="ui-set-pill is-changed" title={t("settings.changedTooltip")}>
              {t("settings.changed")}
            </span>
          ) : null}
        </span>
        {hint ? <span className="ui-set-desc">{hint}</span> : null}
        {lock ? (
          <span className="ui-set-env">
            <Lock size={12} aria-hidden="true" />
            <span>
              {t("settings.env.note")} <bdi className="ui-mono">{lock.variable ?? ""}</bdi>
            </span>
          </span>
        ) : reset ? (
          <button type="button" className="ui-set-clear is-reset" onClick={reset.onReset}>
            <RotateCcw size={12} aria-hidden="true" /> {t("settings.resetTo", { value: reset.label })}
          </button>
        ) : null}
      </div>
      <div className="ui-set-control">{children}</div>
    </div>
  )
}
