// Settings, /settings, admins only (v3 SV-1, FS-6, FS-8): every setting Maane manages, edited in place. Changes wait
// in a draft; the save bar counts them and offers Discard and Save changes (PUT /api/v1/settings with the changed
// keys only); leaving with unsaved changes asks first. A field the environment sets is locked: it stays in place,
// disabled, and names its variable. The server refuses a locked field (setting_locked), an invalid value
// (setting_invalid) and an unknown key (setting_unknown); each refusal is explained and points at its field. A
// refresh never touches a field being edited: the draft holds only what was changed. A field edited again while a
// save is on its way keeps its new text: a save takes out of the draft only what it sent. The intake mode has no
// variable; the server refuses live without a default address (intake_no_default_address) and the refusal points
// at its field.

import { INTAKE_MODES, LOCALES, SETTINGS, type SettingKey, type SettingView } from "@maane/shared"
import { useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { ApiError } from "../api/client.ts"
import { api, qk } from "../api/endpoints.ts"
import { errorText } from "../api/errors.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { nativeName } from "../shell/ShellTools.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { SaveBar } from "../ui/SaveBar.tsx"
import { ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { showToast } from "../ui/Toast.tsx"
import { useUnsaved } from "../ui/unsaved.tsx"
import { AdminOnly } from "./AdminOnly.tsx"
import { FormError } from "./auth/parts.tsx"
import { Group, Row } from "./parts.tsx"

/** Every setting this page shows; guards.test.ts fails when the registry has one that is not here. */
export const SETTING_ROWS: readonly SettingKey[] = ["general.defaultLocale", "security.sessionDays", "intake.mode"]

const SESSION_DAYS_MIN = 1
const SESSION_DAYS_MAX = 90

type Draft = Partial<Record<SettingKey, string>>

/** A loaded value as the field shows it. */
const shown = (view: SettingView | undefined) => (view ? String(view.value ?? "") : "")

/** The value the server takes for a field's text, or null when the text is not a valid value. */
export function parseSetting(key: SettingKey, text: string): unknown {
  if (key === "security.sessionDays") {
    if (!/^\d{1,3}$/.test(text.trim())) return null
    const days = Number(text.trim())
    return days >= SESSION_DAYS_MIN && days <= SESSION_DAYS_MAX ? days : null
  }
  if (key === "intake.mode") return (INTAKE_MODES as readonly string[]).includes(text) ? text : null
  return (LOCALES as readonly string[]).includes(text) ? text : null
}

export function SettingsPage() {
  const { t } = useI18n()
  return (
    <AdminOnly title={t("settings.title")}>
      <Settings />
    </AdminOnly>
  )
}

function Settings() {
  const { t } = useI18n()
  usePageMeta(t("settings.title"))
  const queryClient = useQueryClient()
  const query = usePageQuery({ queryKey: qk.settings, queryFn: api.settings, every: EVERY.slow })
  const [draft, setDraft] = useState<Draft>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ key: SettingKey | null; text: string } | null>(null)
  const daysId = useId()
  const daysRef = useRef<HTMLInputElement>(null)
  const views = new Map((query.data?.settings ?? []).map((view) => [view.key, view]))

  // Only what differs from the saved value counts as a change.
  const changed = (Object.keys(draft) as SettingKey[]).filter((key) => draft[key] !== shown(views.get(key)))
  useUnsaved("settings", { count: changed.length, kind: "leave" })

  const value = (key: SettingKey) => draft[key] ?? shown(views.get(key))
  const edit = (key: SettingKey, text: string) => {
    setDraft((current) => ({ ...current, [key]: text }))
    if (error?.key === key) setError(null)
  }

  // False once the page is gone (left, or remounted for another identity): a late answer must not write the previous
  // identity's settings over the cached ones the next page reads.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const save = async () => {
    const body: Partial<Record<SettingKey, unknown>> = {}
    for (const key of changed) {
      const parsed = parseSetting(key, draft[key] ?? "")
      if (parsed === null) {
        setError({ key, text: t("settings.invalid", { field: t(labelKey(key)) }) })
        if (key === "security.sessionDays") daysRef.current?.focus()
        return
      }
      body[key] = parsed
    }
    const sent: Draft = {}
    for (const key of changed) sent[key] = draft[key]
    setBusy(true)
    setError(null)
    try {
      const saved = await api.saveSettings(body)
      if (!mounted.current) return
      queryClient.setQueryData(qk.settings, saved)
      setDraft((current) => {
        const next = { ...current }
        for (const key of Object.keys(sent) as SettingKey[]) if (next[key] === sent[key]) delete next[key]
        return next
      })
      showToast(t("settings.saved"), "success")
      await queryClient.invalidateQueries({ queryKey: qk.setupStatus })
    } catch (failure) {
      const key = failure instanceof ApiError ? (failure.details.key as SettingKey | undefined) : undefined
      const field = key && views.has(key) ? t(labelKey(key)) : null
      setError({
        key: key ?? null,
        text: field ? t("settings.refusedField", { field, reason: errorText(t, failure) }) : errorText(t, failure),
      })
      if (failure instanceof ApiError && failure.code === "setting_locked")
        await queryClient.invalidateQueries({ queryKey: qk.settings })
    } finally {
      setBusy(false)
    }
  }

  /** A value that differs from its default: Changed, and Reset puts the default in the draft (FS-6). */
  const resetOf = (key: SettingKey) => {
    if (lockOf(key)) return null
    const fallback = String(SETTINGS[key].defaultValue)
    const current = value(key).trim()
    const same = key === "security.sessionDays" ? Number(current) === Number(fallback) : current === fallback
    if (same) return null
    const label =
      key === "general.defaultLocale"
        ? nativeName(fallback as (typeof LOCALES)[number])
        : key === "intake.mode"
          ? t(`settings.intakeMode.mode.${fallback}`)
          : fallback
    return { label, onReset: () => edit(key, fallback) }
  }

  const lockOf = (key: SettingKey) => {
    const view = views.get(key)
    return view?.locked ? { variable: view.variable } : null
  }

  let body: ReactNode
  if (query.isPending) body = <Loading label={t("settings.loading")} />
  else if (query.isError && !query.data)
    body = <ErrorState title={t("settings.failed")} error={query.error} onRetry={() => void query.refetch()} />
  else {
    const locale = "general.defaultLocale" as const
    const days = "security.sessionDays" as const
    const mode = "intake.mode" as const
    body = (
      <>
        <StaleNote failed={query.isError} />
        <Group id="settings-general" title={t("settings.general")}>
          <Row
            label={t(labelKey(locale))}
            hint={t("settings.defaultLocale.hint")}
            lock={lockOf(locale)}
            reset={resetOf(locale)}
          >
            <fieldset className="ui-seg" aria-label={t(labelKey(locale))}>
              {LOCALES.map((option) => (
                <button
                  key={option}
                  type="button"
                  lang={option}
                  aria-pressed={value(locale) === option}
                  disabled={Boolean(lockOf(locale))}
                  onClick={() => edit(locale, option)}
                >
                  {nativeName(option)}
                </button>
              ))}
            </fieldset>
          </Row>
        </Group>
        <Group id="settings-security" title={t("settings.security")}>
          <Row
            label={t(labelKey(days))}
            hint={t("settings.sessionDays.hint", { min: SESSION_DAYS_MIN, max: SESSION_DAYS_MAX })}
            htmlFor={daysId}
            lock={lockOf(days)}
            reset={resetOf(days)}
          >
            <input
              id={daysId}
              ref={daysRef}
              className="ui-input ui-input-num"
              type="number"
              inputMode="numeric"
              min={SESSION_DAYS_MIN}
              max={SESSION_DAYS_MAX}
              step={1}
              dir="ltr"
              disabled={Boolean(lockOf(days))}
              value={value(days)}
              aria-invalid={error?.key === days ? true : undefined}
              onChange={(event) => edit(days, event.target.value)}
            />
          </Row>
        </Group>
        <Group id="settings-intake" title={t("settings.intake")}>
          <Row
            label={t(labelKey(mode))}
            hint={INTAKE_MODES.map((option) => (
              <span key={option} className="ui-set-desc-line">
                {t(`settings.intakeMode.explain.${option}`)}
              </span>
            ))}
            lock={lockOf(mode)}
            reset={resetOf(mode)}
          >
            <fieldset className="ui-seg" aria-label={t(labelKey(mode))}>
              {INTAKE_MODES.map((option) => (
                <button
                  key={option}
                  type="button"
                  data-mode={option}
                  aria-pressed={value(mode) === option}
                  disabled={Boolean(lockOf(mode))}
                  onClick={() => edit(mode, option)}
                >
                  {t(`settings.intakeMode.mode.${option}`)}
                </button>
              ))}
            </fieldset>
          </Row>
        </Group>
        {error ? <FormError>{error.text}</FormError> : null}
      </>
    )
  }

  return (
    <div className="ui-page">
      <PageHead title={t("settings.title")} description={t("settings.description")} />
      <div className="ui-account">{body}</div>
      <SaveBar
        count={changed.length}
        busy={busy}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft({})
          setError(null)
        }}
      />
    </div>
  )
}

/** The label of a setting. */
export function labelKey(key: SettingKey): string {
  if (key === "general.defaultLocale") return "settings.defaultLocale.label"
  if (key === "intake.mode") return "settings.intakeMode.label"
  return "settings.sessionDays.label"
}
