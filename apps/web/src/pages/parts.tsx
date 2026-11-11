// The parts of the Account and Settings pages, after Mikud's Settings parts (v3 FS-6, FS-8): a group is a panel
// with a small title, its count and its list actions at the end of its head; a row has the label and explanation at
// the start and the control at the end. A value the environment sets carries a neutral "Set by the environment" tag
// on its label line and names the variable under the explanation; its control stays in place, disabled.

import { Lock } from "lucide-react"
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

export function Row({
  label,
  hint,
  htmlFor,
  lock,
  changed,
  children,
}: {
  label: string
  hint?: ReactNode
  htmlFor?: string
  lock?: EnvLock | null
  /** The draft differs from what is saved. */
  changed?: boolean
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
          ) : changed ? (
            <span className="ui-set-pill is-changed">{t("settings.changed")}</span>
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
        ) : null}
      </div>
      <div className="ui-set-control">{children}</div>
    </div>
  )
}
