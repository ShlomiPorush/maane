// The parts of the Account and Settings pages, after Mikud's Settings parts (v3 FS-6, FS-8): a group is a panel
// with a small title, its count and its list actions at the end of its head; a row has the label and explanation at
// the start and the control at the end. A value the environment sets carries a neutral "Set by the environment" tag
// on its label line and names the variable under the explanation; its control stays in place, disabled. A value that
// differs from its default carries a Changed tag and a "Reset to default (value)" button; a locked one never does.

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
  /** Actions on the whole list, at the end of the head. */
  extra?: ReactNode
  /** One muted line under the head that says what the group is for. */
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

/** The environment sets this value: the variable that does. */
export type EnvLock = { variable: string | null }
/** The value differs from its default: the default's name, and what puts it back in the draft. */
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
