// Settings, /settings, admins only (v3 SV-1, FS-6, FS-8): every setting Maane manages, edited in place. Changes wait
// in a draft; the save bar counts them and offers Discard and Save changes (PUT /api/v1/settings with the changed
// keys only); leaving with unsaved changes asks first. A field the environment sets is locked: it stays in place,
// disabled, and names its variable. The server refuses a locked field (setting_locked), an invalid value
// (setting_invalid) and an unknown key (setting_unknown); each refusal is explained and points at its field. A
// refresh never touches a field being edited: the draft holds only what was changed. A field edited again while a
// save is on its way keeps its new text: a save takes out of the draft only what it sent. The intake mode has no
// variable; the server refuses live without a default address (intake_no_default_address) and the refusal points
// at its field. Files and scanning (phase 2.2) shows the scanner's latest self-test and a connection test the
// worker runs: the page queues it and reads its state until it is done (the server never calls the scanner). Microsoft
// Graph (phase 2.3) holds the tenant, the application, its client secret (write only: the page shows whether one is
// set, never the value, and an empty field keeps it), and the intake mailbox, and a connection test the worker runs the
// same way: it reads only the mailbox's Inbox folder details and reports Graph's error code. Sending (phase 3.1) holds
// SMTP2GO's SMTP server and API key, the failover server, and the bounce address, with a connection test of each
// server that the worker runs the same way (it connects with TLS and logs in, and sends nothing).

import {
  BLOCKED_TYPE,
  BLOCKED_TYPES_MAX,
  FILES_MAX_BYTES_MAX,
  FILES_MAX_BYTES_MIN,
  GRAPH_SECRET_MAX,
  type GraphTestResult,
  INTAKE_MODES,
  isClientId,
  isHostName,
  isMailbox,
  isTenantId,
  LOCALES,
  MEGABYTE,
  normalizeBlockedTypes,
  parseScannerAddress,
  SCAN_TIMEOUT_MAX_SECONDS,
  SCAN_TIMEOUT_MIN_SECONDS,
  SCANNER_POLICIES,
  type ScannerStatusView,
  SETTINGS,
  type SettingKey,
  type SettingView,
  SMTP_SECURITIES,
  type SmtpTestResult,
} from "@maane/shared"
import { useQueryClient } from "@tanstack/react-query"
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react"
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
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Tag } from "../ui/tags.tsx"
import { useUnsaved } from "../ui/unsaved.tsx"
import { AdminOnly } from "./AdminOnly.tsx"
import { FormError } from "./auth/parts.tsx"
import { Group, Row } from "./parts.tsx"

/** Every setting this page shows; guards.test.ts fails when the registry has one that is not here. */
export const SETTING_ROWS: readonly SettingKey[] = [
  "general.defaultLocale",
  "security.sessionDays",
  "intake.mode",
  "graph.tenantId",
  "graph.clientId",
  "graph.clientSecret",
  "graph.mailbox",
  "scanner.address",
  "scanner.unavailablePolicy",
  "scanner.scanTimeoutSeconds",
  "files.maxBytes",
  "files.blockedTypes",
  "smtp2go.host",
  "smtp2go.port",
  "smtp2go.user",
  "smtp2go.password",
  "smtp2go.apiKey",
  "failover.host",
  "failover.port",
  "failover.security",
  "failover.user",
  "failover.password",
  "mail.bounceAddress",
]

/** The sending settings of each SMTP server, in the order the page shows them; the connection test reads them saved. */
const SMTP2GO_KEYS: readonly SettingKey[] = ["smtp2go.host", "smtp2go.port", "smtp2go.user", "smtp2go.password"]
const FAILOVER_KEYS: readonly SettingKey[] = [
  "failover.host",
  "failover.port",
  "failover.security",
  "failover.user",
  "failover.password",
]
/** Secrets of sending: write only, like Graph's client secret. */
const SENDING_SECRETS: readonly SettingKey[] = ["smtp2go.password", "smtp2go.apiKey", "failover.password"]
/** Values that are code-like: shown left to right in a mono font. */
const SENDING_CODE: readonly SettingKey[] = ["smtp2go.host", "smtp2go.user", "failover.host", "failover.user"]

const SESSION_DAYS_MIN = 1
const SESSION_DAYS_MAX = 90
const MAX_MB_MIN = FILES_MAX_BYTES_MIN / MEGABYTE
const MAX_MB_MAX = FILES_MAX_BYTES_MAX / MEGABYTE

/** How often the page reads a queued connection test, and how long it waits for the worker before it gives up. */
const TEST_POLL_MS = 1_500
const TEST_WAIT_MS = 90_000

type Draft = Partial<Record<SettingKey, string>>

/** The Graph fields: the connection test uses their saved values, so it waits while one of them is unsaved. */
const GRAPH_KEYS: readonly SettingKey[] = ["graph.tenantId", "graph.clientId", "graph.clientSecret", "graph.mailbox"]

/** Fields without a default to go back to: empty until the owner sets them. */
const NO_DEFAULT: readonly SettingKey[] = [
  ...GRAPH_KEYS,
  "smtp2go.user",
  "smtp2go.password",
  "smtp2go.apiKey",
  "failover.host",
  "failover.user",
  "failover.password",
  "mail.bounceAddress",
]

/** A secret's text: one line without white space at either end, as the registry takes it. */
const secretText = (text: string) => (text.length <= GRAPH_SECRET_MAX && /^\S(?:[^\r\n]*\S)?$/.test(text) ? text : null)

/** A value as its field shows it: the size in MB, the blocked types one list. */
export function settingText(key: SettingKey, value: unknown): string {
  if (key === "files.maxBytes" && typeof value === "number") return String(value / MEGABYTE)
  if (key === "files.blockedTypes" && Array.isArray(value)) return value.join(", ")
  return String(value ?? "")
}

/** A loaded value as the field shows it. */
const shown = (view: SettingView | undefined) => (view ? settingText(view.key, view.value) : "")

/** The value the server takes for a field's text, or null when the text is not a valid value. */
export function parseSetting(key: SettingKey, text: string): unknown {
  if (key === "security.sessionDays") {
    if (!/^\d{1,3}$/.test(text.trim())) return null
    const days = Number(text.trim())
    return days >= SESSION_DAYS_MIN && days <= SESSION_DAYS_MAX ? days : null
  }
  if (key === "scanner.scanTimeoutSeconds") {
    if (!/^\d{1,3}$/.test(text.trim())) return null
    const seconds = Number(text.trim())
    return seconds >= SCAN_TIMEOUT_MIN_SECONDS && seconds <= SCAN_TIMEOUT_MAX_SECONDS ? seconds : null
  }
  if (key === "files.maxBytes") {
    if (!/^\d{1,3}$/.test(text.trim())) return null
    const megabytes = Number(text.trim())
    return megabytes >= MAX_MB_MIN && megabytes <= MAX_MB_MAX ? megabytes * MEGABYTE : null
  }
  if (key === "files.blockedTypes") {
    const list = normalizeBlockedTypes(text)
    return list.length <= BLOCKED_TYPES_MAX && list.every((entry) => BLOCKED_TYPE.test(entry)) ? list : null
  }
  if (key === "scanner.address") return parseScannerAddress(text.trim()) ? text.trim() : null
  if (key === "graph.tenantId") return text.trim() === "" || isTenantId(text.trim()) ? text.trim() : null
  if (key === "graph.clientId") return text.trim() === "" || isClientId(text.trim()) ? text.trim() : null
  if (key === "graph.mailbox") return text.trim() === "" || isMailbox(text.trim()) ? text.trim().toLowerCase() : null
  if (key === "graph.clientSecret" || SENDING_SECRETS.includes(key)) return secretText(text)
  if (key === "smtp2go.port" || key === "failover.port") {
    if (!/^\d{1,5}$/.test(text.trim())) return null
    const port = Number(text.trim())
    return port >= 1 && port <= 65535 ? port : null
  }
  if (key === "smtp2go.host" || key === "failover.host")
    return text.trim() === "" || isHostName(text.trim()) ? text.trim() : null
  if (key === "smtp2go.user" || key === "failover.user")
    return text.trim().length <= 255 && !/[\r\n]/.test(text) ? text.trim() : null
  if (key === "mail.bounceAddress")
    return text.trim() === "" || isMailbox(text.trim()) ? text.trim().toLowerCase() : null
  if (key === "failover.security") return (SMTP_SECURITIES as readonly string[]).includes(text) ? text : null
  if (key === "scanner.unavailablePolicy") return (SCANNER_POLICIES as readonly string[]).includes(text) ? text : null
  if (key === "intake.mode") return (INTAKE_MODES as readonly string[]).includes(text) ? text : null
  return (LOCALES as readonly string[]).includes(text) ? text : null
}

/** Whether a field's text means the same value, so typing "50" over 50 or reordering spaces is no change (SV-2). */
function sameValue(key: SettingKey, text: string, value: unknown): boolean {
  const parsed = parseSetting(key, text)
  return parsed !== null && JSON.stringify(parsed) === JSON.stringify(value)
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
  const addressId = useId()
  const maxId = useId()
  const scanTimeoutId = useId()
  const typesId = useId()
  const tenantId = useId()
  const clientId = useId()
  const secretId = useId()
  const mailboxId = useId()
  const fieldRefs: Partial<Record<SettingKey, RefObject<HTMLInputElement | HTMLTextAreaElement | null>>> = {
    "security.sessionDays": useRef<HTMLInputElement>(null),
    "scanner.address": useRef<HTMLInputElement>(null),
    "files.maxBytes": useRef<HTMLInputElement>(null),
    "scanner.scanTimeoutSeconds": useRef<HTMLInputElement>(null),
    "files.blockedTypes": useRef<HTMLTextAreaElement>(null),
    "graph.tenantId": useRef<HTMLInputElement>(null),
    "graph.clientId": useRef<HTMLInputElement>(null),
    "graph.clientSecret": useRef<HTMLInputElement>(null),
    "graph.mailbox": useRef<HTMLInputElement>(null),
    "smtp2go.host": useRef<HTMLInputElement>(null),
    "smtp2go.port": useRef<HTMLInputElement>(null),
    "smtp2go.user": useRef<HTMLInputElement>(null),
    "smtp2go.password": useRef<HTMLInputElement>(null),
    "smtp2go.apiKey": useRef<HTMLInputElement>(null),
    "failover.host": useRef<HTMLInputElement>(null),
    "failover.port": useRef<HTMLInputElement>(null),
    "failover.user": useRef<HTMLInputElement>(null),
    "failover.password": useRef<HTMLInputElement>(null),
    "mail.bounceAddress": useRef<HTMLInputElement>(null),
  }
  const sendingIds = useId()
  const views = new Map((query.data?.settings ?? []).map((view) => [view.key, view]))

  // Only what differs from the saved value counts as a change.
  const changed = (Object.keys(draft) as SettingKey[]).filter((key) => {
    const view = views.get(key)
    return draft[key] !== shown(view) && !sameValue(key, draft[key] ?? "", view?.value)
  })
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
        fieldRefs[key]?.current?.focus()
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
      // A new address is tested by the worker now; its result shows when it arrives.
      if ("scanner.address" in body) await queryClient.invalidateQueries({ queryKey: qk.scanner })
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

  const lockOf = (key: SettingKey) => {
    const view = views.get(key)
    return view?.locked ? { variable: view.variable } : null
  }

  /** A value that differs from its default: Changed, and Reset puts the default in the draft (FS-6). */
  const resetOf = (key: SettingKey) => {
    // A Graph field has no default to go back to: it is empty until the owner sets it.
    if (lockOf(key) || !views.has(key) || NO_DEFAULT.includes(key)) return null
    const fallback = SETTINGS[key].defaultValue
    if (sameValue(key, value(key), fallback)) return null
    const fallbackText = settingText(key, fallback)
    const label =
      key === "general.defaultLocale"
        ? nativeName(fallbackText as (typeof LOCALES)[number])
        : key === "intake.mode"
          ? t(`settings.intakeMode.mode.${fallbackText}`)
          : key === "scanner.unavailablePolicy"
            ? t(`settings.scannerPolicy.mode.${fallbackText}`)
            : key === "failover.security"
              ? t(`settings.sending.security.${fallbackText}`)
              : key === "files.blockedTypes"
                ? t("settings.blockedTypes.defaultList")
                : fallbackText
    return { label, onReset: () => edit(key, fallbackText) }
  }

  /** A text or number field of a setting, left to right where its value is code-like. */
  const field = (
    key: SettingKey,
    id: string,
    props: {
      className?: string
      ltr?: boolean
      numeric?: { min: number; max: number }
      /** Write only: never filled from the server, and empty keeps the stored value. */
      secret?: { placeholder: string }
    },
  ) => (
    <input
      id={id}
      ref={fieldRefs[key] as RefObject<HTMLInputElement>}
      className={`ui-input ${props.className ?? ""}`.trim()}
      data-setting={key}
      type={props.numeric ? "number" : props.secret ? "password" : "text"}
      placeholder={props.secret?.placeholder}
      inputMode={props.numeric ? "numeric" : undefined}
      min={props.numeric?.min}
      max={props.numeric?.max}
      step={props.numeric ? 1 : undefined}
      dir={props.ltr || props.numeric ? "ltr" : undefined}
      spellCheck={props.ltr ? false : undefined}
      autoComplete={props.secret ? "new-password" : "off"}
      disabled={Boolean(lockOf(key))}
      value={value(key)}
      aria-invalid={error?.key === key ? true : undefined}
      onChange={(event) => edit(key, event.target.value)}
    />
  )

  let body: ReactNode
  if (query.isPending) body = <Loading label={t("settings.loading")} />
  else if (query.isError && !query.data)
    body = <ErrorState title={t("settings.failed")} error={query.error} onRetry={() => void query.refetch()} />
  else {
    const locale = "general.defaultLocale" as const
    const days = "security.sessionDays" as const
    const mode = "intake.mode" as const
    const address = "scanner.address" as const
    const policy = "scanner.unavailablePolicy" as const
    const scanTimeout = "scanner.scanTimeoutSeconds" as const
    const maxBytes = "files.maxBytes" as const
    const types = "files.blockedTypes" as const
    const tenant = "graph.tenantId" as const
    const client = "graph.clientId" as const
    const clientSecret = "graph.clientSecret" as const
    const mailbox = "graph.mailbox" as const
    const secret = views.get(clientSecret)
    /** One sending setting's row: a write-only secret, the security choice, or a text or number field. */
    const sendingRow = (key: SettingKey) => {
      const id = `${sendingIds}-${key}`
      const label = t(labelKey(key))
      const hint = t(`settings.sending.${key}.hint`, { example: "example.com" })
      if (key === "failover.security")
        return (
          <Row key={key} label={label} hint={hint} lock={lockOf(key)} reset={resetOf(key)}>
            <fieldset className="ui-seg" aria-label={label}>
              {SMTP_SECURITIES.map((option) => (
                <button
                  key={option}
                  type="button"
                  data-security={option}
                  aria-pressed={value(key) === option}
                  disabled={Boolean(lockOf(key))}
                  onClick={() => edit(key, option)}
                >
                  {t(`settings.sending.security.${option}`)}
                </button>
              ))}
            </fieldset>
          </Row>
        )
      const stored = views.get(key)
      const isSecret = SENDING_SECRETS.includes(key)
      const isPort = key === "smtp2go.port" || key === "failover.port"
      return (
        <Row key={key} label={label} hint={hint} htmlFor={id} lock={lockOf(key)} reset={resetOf(key)}>
          {isSecret ? (
            <span className="ui-scanner-line">
              <Tag tone={stored?.set ? "ok" : "neutral"}>
                {stored?.set ? t("settings.graphSecret.set") : t("settings.graphSecret.notSet")}
              </Tag>
            </span>
          ) : null}
          {field(key, id, {
            className: isPort ? "ui-input-num" : isSecret || SENDING_CODE.includes(key) ? "ui-mono" : undefined,
            ltr: true,
            numeric: isPort ? { min: 1, max: 65535 } : undefined,
            secret: isSecret
              ? { placeholder: stored?.set ? t("settings.graphSecret.replace") : t("settings.sending.enterSecret") }
              : undefined,
          })}
        </Row>
      )
    }
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
            {field(days, daysId, {
              className: "ui-input-num",
              numeric: { min: SESSION_DAYS_MIN, max: SESSION_DAYS_MAX },
            })}
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
        <Group id="settings-graph" title={t("settings.graphGroup")} intro={t("settings.graphIntro")}>
          <GraphRow fieldsChanged={changed.some((key) => GRAPH_KEYS.includes(key))} />
          <Row
            label={t(labelKey(tenant))}
            hint={t("settings.graphTenant.hint", { example: "example.onmicrosoft.com" })}
            htmlFor={tenantId}
            lock={lockOf(tenant)}
          >
            {field(tenant, tenantId, { className: "ui-mono", ltr: true })}
          </Row>
          <Row
            label={t(labelKey(client))}
            hint={t("settings.graphClient.hint")}
            htmlFor={clientId}
            lock={lockOf(client)}
          >
            {field(client, clientId, { className: "ui-mono", ltr: true })}
          </Row>
          <Row
            label={t(labelKey(clientSecret))}
            hint={t("settings.graphSecret.hint")}
            htmlFor={secretId}
            lock={lockOf(clientSecret)}
          >
            <span className="ui-scanner-line">
              <Tag tone={secret?.set ? "ok" : "neutral"}>
                {secret?.set ? t("settings.graphSecret.set") : t("settings.graphSecret.notSet")}
              </Tag>
            </span>
            {field(clientSecret, secretId, {
              className: "ui-mono",
              ltr: true,
              secret: {
                placeholder: secret?.set ? t("settings.graphSecret.replace") : t("settings.graphSecret.enter"),
              },
            })}
          </Row>
          <Row
            label={t(labelKey(mailbox))}
            hint={t("settings.graphMailbox.hint", { example: "intake@example.com" })}
            htmlFor={mailboxId}
            lock={lockOf(mailbox)}
          >
            {field(mailbox, mailboxId, { ltr: true })}
          </Row>
        </Group>
        <Group id="settings-files" title={t("settings.files")} intro={t("settings.filesIntro")}>
          <ScannerRow addressChanged={changed.includes(address)} />
          <Row
            label={t(labelKey(address))}
            hint={t("settings.scannerAddress.hint", {
              form: "host:port",
              bundled: SETTINGS["scanner.address"].defaultValue,
              alerts: "AlertExceedsMax, AlertEncrypted, AlertEncryptedArchive, AlertEncryptedDoc",
              stream: "StreamMaxLength",
            })}
            htmlFor={addressId}
            lock={lockOf(address)}
            reset={resetOf(address)}
          >
            {field(address, addressId, { className: "ui-mono", ltr: true })}
          </Row>
          <Row
            label={t(labelKey(scanTimeout))}
            hint={t("settings.scanTimeout.hint", { min: SCAN_TIMEOUT_MIN_SECONDS, max: SCAN_TIMEOUT_MAX_SECONDS })}
            htmlFor={scanTimeoutId}
            lock={lockOf(scanTimeout)}
            reset={resetOf(scanTimeout)}
          >
            {field(scanTimeout, scanTimeoutId, {
              className: "ui-input-num",
              numeric: { min: SCAN_TIMEOUT_MIN_SECONDS, max: SCAN_TIMEOUT_MAX_SECONDS },
            })}
          </Row>
          <Row
            label={t(labelKey(policy))}
            hint={SCANNER_POLICIES.map((option) => (
              <span key={option} className="ui-set-desc-line">
                {t(`settings.scannerPolicy.explain.${option}`)}
              </span>
            ))}
            lock={lockOf(policy)}
            reset={resetOf(policy)}
          >
            <fieldset className="ui-seg" aria-label={t(labelKey(policy))}>
              {SCANNER_POLICIES.map((option) => (
                <button
                  key={option}
                  type="button"
                  data-policy={option}
                  aria-pressed={value(policy) === option}
                  disabled={Boolean(lockOf(policy))}
                  onClick={() => edit(policy, option)}
                >
                  {t(`settings.scannerPolicy.mode.${option}`)}
                </button>
              ))}
            </fieldset>
          </Row>
          <Row
            label={t(labelKey(maxBytes))}
            hint={t("settings.maxBytes.hint", { min: MAX_MB_MIN, max: MAX_MB_MAX })}
            htmlFor={maxId}
            lock={lockOf(maxBytes)}
            reset={resetOf(maxBytes)}
          >
            {field(maxBytes, maxId, { className: "ui-input-num", numeric: { min: MAX_MB_MIN, max: MAX_MB_MAX } })}
          </Row>
          <Row
            label={t(labelKey(types))}
            hint={t("settings.blockedTypes.hint")}
            htmlFor={typesId}
            lock={lockOf(types)}
            reset={resetOf(types)}
          >
            <textarea
              id={typesId}
              ref={fieldRefs[types] as RefObject<HTMLTextAreaElement>}
              className="ui-input ui-textarea ui-mono"
              dir="ltr"
              rows={5}
              spellCheck={false}
              autoComplete="off"
              disabled={Boolean(lockOf(types))}
              value={value(types)}
              aria-invalid={error?.key === types ? true : undefined}
              onChange={(event) => edit(types, event.target.value)}
            />
          </Row>
        </Group>
        <Group id="settings-smtp2go" title={t("settings.sending.smtp2goTitle")} intro={t("settings.sending.intro")}>
          <SmtpRow provider="smtp2go" fieldsChanged={changed.some((key) => SMTP2GO_KEYS.includes(key))} />
          {SMTP2GO_KEYS.map(sendingRow)}
          {sendingRow("smtp2go.apiKey")}
        </Group>
        <Group
          id="settings-failover"
          title={t("settings.sending.failoverTitle")}
          intro={t("settings.sending.failoverIntro")}
        >
          <SmtpRow provider="failover" fieldsChanged={changed.some((key) => FAILOVER_KEYS.includes(key))} />
          {FAILOVER_KEYS.map(sendingRow)}
          {sendingRow("mail.bounceAddress")}
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

/**
 * The Graph connection test: the worker reads the saved mailbox's Inbox folder details and nothing else, and the page
 * reads the job's state until it is done. The result stays on the page until it is left; nothing stores it. The test
 * waits while a Graph field is unsaved, because it uses the saved settings.
 */
function GraphRow({ fieldsChanged }: { fieldsChanged: boolean }) {
  const { t } = useI18n()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<GraphTestResult | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const test = async () => {
    setTesting(true)
    try {
      const { id } = await api.testGraph()
      const until = Date.now() + TEST_WAIT_MS
      while (mounted.current && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, TEST_POLL_MS))
        if (!mounted.current) return
        const job = await api.graphTest(id)
        if (job.state === "done" && job.result) {
          const done = job.result
          setResult(done)
          if (done.ok) showToast(t("settings.graph.test.okToast"), "success")
          else
            showToast(
              t("settings.graph.test.failedToast", { problem: t(`settings.graph.problem.${done.problem ?? "error"}`) }),
              "error",
            )
          return
        }
        if (job.state === "failed") break
      }
      if (mounted.current) showToast(t("settings.graph.test.noAnswer"), "error")
    } catch (failure) {
      if (mounted.current) showToast(errorText(t, failure), "error")
    } finally {
      if (mounted.current) setTesting(false)
    }
  }

  return (
    <Row label={t("settings.graph.test.label")} hint={t("settings.graph.test.hint")}>
      <div className="ui-scanner" aria-live="polite">
        {result ? (
          <>
            <span className="ui-scanner-line">
              <Tag tone={result.ok ? "ok" : "fail"}>
                {result.ok ? t("settings.graph.test.passed") : t("settings.graph.test.failed")}
              </Tag>
              <span className="ui-scanner-note">
                {t("settings.graph.test.checked")} <Time value={result.checkedAt} mode="ago" />
              </span>
            </span>
            {result.problem ? (
              <span className="ui-scanner-fail">{t(`settings.graph.problem.${result.problem}`)}</span>
            ) : null}
            {result.code ? (
              <span className="ui-scanner-note">
                {t("settings.graph.test.code")} <bdi className="ui-mono">{result.code}</bdi>
              </span>
            ) : null}
            {result.mailbox ? (
              <span className="ui-scanner-note">
                {t("settings.graph.test.mailbox")} <bdi dir="ltr">{result.mailbox}</bdi>
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className="ui-scanner-line">
              <Tag tone="neutral">{t("settings.graph.test.notTested")}</Tag>
            </span>
            <span className="ui-scanner-note">{t("settings.graph.test.notTestedNote")}</span>
          </>
        )}
      </div>
      <button
        type="button"
        className="ui-btn ui-btn-sm"
        disabled={testing || fieldsChanged}
        aria-busy={testing || undefined}
        onClick={() => void test()}
      >
        {testing ? t("settings.graph.test.testing") : t("settings.graph.test.button")}
      </button>
      {fieldsChanged ? <span className="ui-hint">{t("settings.graph.test.saveFirst")}</span> : null}
    </Row>
  )
}

/**
 * The SMTP connection test of one server: the worker connects with TLS and logs in with the saved settings
 * (nodemailer's transporter.verify()), sends nothing, and the page reads the job's state until it is done. It waits
 * while one of that server's fields is unsaved.
 */
function SmtpRow({ provider, fieldsChanged }: { provider: "smtp2go" | "failover"; fieldsChanged: boolean }) {
  const { t } = useI18n()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<SmtpTestResult | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const test = async () => {
    setTesting(true)
    try {
      const { id } = await api.testSmtp(provider)
      const until = Date.now() + TEST_WAIT_MS
      while (mounted.current && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, TEST_POLL_MS))
        if (!mounted.current) return
        const job = await api.smtpTest(id)
        if (job.state === "done" && job.result) {
          const done = job.result
          setResult(done)
          if (done.ok) showToast(t("settings.sending.test.okToast"), "success")
          else
            showToast(
              t("settings.sending.test.failedToast", {
                problem: t(`settings.sending.problem.${done.problem ?? "error"}`),
              }),
              "error",
            )
          return
        }
        if (job.state === "failed") break
      }
      if (mounted.current) showToast(t("settings.graph.test.noAnswer"), "error")
    } catch (failure) {
      if (mounted.current) showToast(errorText(t, failure), "error")
    } finally {
      if (mounted.current) setTesting(false)
    }
  }

  return (
    <Row label={t("settings.graph.test.label")} hint={t("settings.sending.test.hint")}>
      <div className="ui-scanner" aria-live="polite" data-smtp-test={provider}>
        {result ? (
          <>
            <span className="ui-scanner-line">
              <Tag tone={result.ok ? "ok" : "fail"}>
                {result.ok ? t("settings.graph.test.passed") : t("settings.graph.test.failed")}
              </Tag>
              <span className="ui-scanner-note">
                {t("settings.graph.test.checked")} <Time value={result.checkedAt} mode="ago" />
              </span>
            </span>
            {result.problem ? (
              <span className="ui-scanner-fail">{t(`settings.sending.problem.${result.problem}`)}</span>
            ) : null}
            {result.code ? (
              <span className="ui-scanner-note">
                {t("settings.graph.test.code")} <bdi className="ui-mono">{result.code}</bdi>
              </span>
            ) : null}
            {result.response ? (
              <span className="ui-scanner-note">
                <bdi className="ui-mono" dir="ltr">
                  {result.response}
                </bdi>
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className="ui-scanner-line">
              <Tag tone="neutral">{t("settings.graph.test.notTested")}</Tag>
            </span>
            <span className="ui-scanner-note">{t("settings.graph.test.notTestedNote")}</span>
          </>
        )}
      </div>
      <button
        type="button"
        className="ui-btn ui-btn-sm"
        disabled={testing || fieldsChanged}
        aria-busy={testing || undefined}
        onClick={() => void test()}
      >
        {testing ? t("settings.graph.test.testing") : t(`settings.sending.test.${provider}`)}
      </button>
      {fieldsChanged ? <span className="ui-hint">{t("settings.sending.test.saveFirst")}</span> : null}
    </Row>
  )
}

/**
 * The scanner's latest self-test (its own read, every 30 seconds) and Test connection: the worker runs the test from
 * the queue and the page reads its state until it is done. The test checks the saved address, so it waits while a
 * new address is still unsaved.
 */
function ScannerRow({ addressChanged }: { addressChanged: boolean }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const status = usePageQuery({ queryKey: qk.scanner, queryFn: api.scannerStatus, every: EVERY.live })
  const [testing, setTesting] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const test = async () => {
    setTesting(true)
    try {
      const { id } = await api.testScanner()
      const until = Date.now() + TEST_WAIT_MS
      while (mounted.current && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, TEST_POLL_MS))
        if (!mounted.current) return
        const job = await api.scannerTest(id)
        if (job.state === "done" && job.result) {
          const result = job.result
          queryClient.setQueryData(qk.scanner, { status: result })
          if (result.ok) showToast(t("settings.scanner.testPassed"), "success")
          else
            showToast(
              t("settings.scanner.testFailed", {
                check: t(`settings.scanner.check.${result.failedCheck ?? "connection"}`),
              }),
              "error",
            )
          return
        }
        if (job.state === "failed") break
      }
      if (mounted.current) showToast(t("settings.scanner.testNoAnswer"), "error")
    } catch (failure) {
      if (mounted.current) showToast(errorText(t, failure), "error")
    } finally {
      if (mounted.current) setTesting(false)
    }
  }

  const button = (
    <button
      type="button"
      className="ui-btn ui-btn-sm"
      disabled={testing || addressChanged}
      aria-busy={testing || undefined}
      onClick={() => void test()}
    >
      {testing ? t("settings.scanner.testing") : t("settings.scanner.test")}
    </button>
  )

  let state: ReactNode
  if (status.isPending) state = <span className="ui-muted">{t("settings.loading")}</span>
  else if (status.isError && !status.data) state = <span className="ui-muted">{t("settings.scanner.loadFailed")}</span>
  else state = <ScannerState status={status.data?.status ?? null} />

  return (
    <Row label={t("settings.scanner.label")} hint={t("settings.scanner.hint")}>
      <div className="ui-scanner" aria-live="polite">
        {state}
      </div>
      {button}
      {addressChanged ? <span className="ui-hint">{t("settings.scanner.saveFirst")}</span> : null}
    </Row>
  )
}

function ScannerState({ status }: { status: ScannerStatusView | null }) {
  const { t } = useI18n()
  if (!status)
    return (
      <>
        <span className="ui-scanner-line">
          <Tag tone="neutral">{t("settings.scanner.notChecked")}</Tag>
        </span>
        <span className="ui-scanner-note">{t("settings.scanner.notCheckedNote")}</span>
      </>
    )
  const engine = engineOf(status.version)
  return (
    <>
      <span className="ui-scanner-line">
        <Tag tone={status.ok ? "ok" : "fail"}>
          {status.ok ? t("settings.scanner.passed") : t("settings.scanner.failed")}
        </Tag>
        <span className="ui-scanner-note">
          {t("settings.scanner.checked")} <Time value={status.checkedAt} mode="ago" />
        </span>
      </span>
      {status.failedCheck ? (
        <span className="ui-scanner-fail">{t(`settings.scanner.check.${status.failedCheck}`)}</span>
      ) : null}
      <span className="ui-scanner-note">{t("settings.scanner.tested", { address: status.address })}</span>
      {engine ? <span className="ui-scanner-note">{t("settings.scanner.version", engine)}</span> : null}
    </>
  )
}

/**
 * clamd's version line, "ClamAV <engine>/<signatures>/<date of the signatures>", as the engine and the signature
 * version only: the date in it is written with an English month name, which Maane never shows (FW-9).
 */
export function engineOf(version: string | null): { version: string; signatures: string } | null {
  const match = version ? /^ClamAV ([^/\s]+)\/(\d+)/.exec(version) : null
  return match?.[1] && match[2] ? { version: match[1], signatures: match[2] } : null
}

/** The label of a setting. */
export function labelKey(key: SettingKey): string {
  if (key === "general.defaultLocale") return "settings.defaultLocale.label"
  if (key === "intake.mode") return "settings.intakeMode.label"
  if (key === "scanner.address") return "settings.scannerAddress.label"
  if (key === "scanner.unavailablePolicy") return "settings.scannerPolicy.label"
  if (key === "scanner.scanTimeoutSeconds") return "settings.scanTimeout.label"
  if (key === "files.maxBytes") return "settings.maxBytes.label"
  if (key === "files.blockedTypes") return "settings.blockedTypes.label"
  if (key === "graph.tenantId") return "settings.graphTenant.label"
  if (key === "graph.clientId") return "settings.graphClient.label"
  if (key === "graph.clientSecret") return "settings.graphSecret.label"
  if (key === "graph.mailbox") return "settings.graphMailbox.label"
  if (key.startsWith("smtp2go.") || key.startsWith("failover.") || key === "mail.bounceAddress")
    return `settings.sending.${key}.label`
  return "settings.sessionDays.label"
}
