import {
  BLOCKED_TYPE,
  BLOCKED_TYPES_MAX,
  FILES_MAX_BYTES_MAX,
  FILES_MAX_BYTES_MIN,
  GRAPH_SECRET_MAX,
  type GraphTestResult,
  isClientId,
  isHostName,
  isLinkDomain,
  isMailbox,
  isTenantId,
  LINK_TRACKING,
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
  type WebhookSecretsView,
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
import { Copyable } from "../ui/Copyable.tsx"
import { confirmDialog } from "../ui/confirm.tsx"
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

export const SETTING_ROWS: readonly SettingKey[] = [
  "general.defaultLocale",
  "security.sessionDays",
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
  "smtp2go.webhookPath",
  "smtp2go.webhookToken",
  "failover.host",
  "failover.port",
  "failover.security",
  "failover.user",
  "failover.password",
  "mail.bounceAddress",
  "links.tracking",
  "links.domain",
]

const SMTP2GO_KEYS: readonly SettingKey[] = ["smtp2go.host", "smtp2go.port", "smtp2go.user", "smtp2go.password"]
const FAILOVER_KEYS: readonly SettingKey[] = [
  "failover.host",
  "failover.port",
  "failover.security",
  "failover.user",
  "failover.password",
]
const SENDING_SECRETS: readonly SettingKey[] = ["smtp2go.password", "smtp2go.apiKey", "failover.password"]
const SENDING_CODE: readonly SettingKey[] = ["smtp2go.host", "smtp2go.user", "failover.host", "failover.user"]

const SESSION_DAYS_MIN = 1
const SESSION_DAYS_MAX = 90
const MAX_MB_MIN = FILES_MAX_BYTES_MIN / MEGABYTE
const MAX_MB_MAX = FILES_MAX_BYTES_MAX / MEGABYTE

const TEST_POLL_MS = 1_500
const TEST_WAIT_MS = 90_000

type Draft = Partial<Record<SettingKey, string>>

const GRAPH_KEYS: readonly SettingKey[] = ["graph.tenantId", "graph.clientId", "graph.clientSecret", "graph.mailbox"]

const NO_DEFAULT: readonly SettingKey[] = [
  ...GRAPH_KEYS,
  "smtp2go.user",
  "smtp2go.password",
  "smtp2go.apiKey",
  "failover.host",
  "failover.user",
  "failover.password",
  "mail.bounceAddress",
  "links.domain",
]

const secretText = (text: string) => (text.length <= GRAPH_SECRET_MAX && /^\S(?:[^\r\n]*\S)?$/.test(text) ? text : null)

export function settingText(key: SettingKey, value: unknown): string {
  if (key === "files.maxBytes" && typeof value === "number") return String(value / MEGABYTE)
  if (key === "files.blockedTypes" && Array.isArray(value)) return value.join(", ")
  return String(value ?? "")
}

const shown = (view: SettingView | undefined) => (view ? settingText(view.key, view.value) : "")

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
  if (key === "links.tracking") return (LINK_TRACKING as readonly string[]).includes(text) ? text : null
  if (key === "links.domain")
    return text.trim() === "" || isLinkDomain(text.trim().toLowerCase()) ? text.trim().toLowerCase() : null
  if (key === "scanner.unavailablePolicy") return (SCANNER_POLICIES as readonly string[]).includes(text) ? text : null
  return (LOCALES as readonly string[]).includes(text) ? text : null
}

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
    "links.domain": useRef<HTMLInputElement>(null),
  }
  const sendingIds = useId()
  const linkDomainId = useId()
  const views = new Map((query.data?.settings ?? []).map((view) => [view.key, view]))

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

  const resetOf = (key: SettingKey) => {
    if (lockOf(key) || !views.has(key) || NO_DEFAULT.includes(key)) return null
    const fallback = SETTINGS[key].defaultValue
    if (sameValue(key, value(key), fallback)) return null
    const fallbackText = settingText(key, fallback)
    const label =
      key === "general.defaultLocale"
        ? nativeName(fallbackText as (typeof LOCALES)[number])
        : key === "scanner.unavailablePolicy"
          ? t(`settings.scannerPolicy.mode.${fallbackText}`)
          : key === "failover.security"
            ? t(`settings.sending.security.${fallbackText}`)
            : key === "links.tracking"
              ? t(`settings.linkTracking.mode.${fallbackText}`)
              : key === "files.blockedTypes"
                ? t("settings.blockedTypes.defaultList")
                : fallbackText
    return { label, onReset: () => edit(key, fallbackText) }
  }

  const field = (
    key: SettingKey,
    id: string,
    props: {
      className?: string
      ltr?: boolean
      numeric?: { min: number; max: number }
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
    const address = "scanner.address" as const
    const policy = "scanner.unavailablePolicy" as const
    const scanTimeout = "scanner.scanTimeoutSeconds" as const
    const maxBytes = "files.maxBytes" as const
    const types = "files.blockedTypes" as const
    const tenant = "graph.tenantId" as const
    const client = "graph.clientId" as const
    const clientSecret = "graph.clientSecret" as const
    const mailbox = "graph.mailbox" as const
    const tracking = "links.tracking" as const
    const linkDomain = "links.domain" as const
    const secret = views.get(clientSecret)
    const sendingRow = (key: SettingKey) => {
      const id = `${sendingIds}-${key}`
      const label = t(labelKey(key))
      const hint = t(`settings.sending.${key}.hint`, { example: "bounces@example.com" })
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
          <WebhookRow
            set={Boolean(views.get("smtp2go.webhookPath")?.set && views.get("smtp2go.webhookToken")?.set)}
            onMade={() => void queryClient.invalidateQueries({ queryKey: qk.settings })}
          />
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
        <Group id="settings-links" title={t("settings.linksGroup")} intro={t("settings.linksIntro")}>
          <Row
            label={t(labelKey(tracking))}
            hint={LINK_TRACKING.map((option) => (
              <span key={option} className="ui-set-desc-line">
                {t(`settings.linkTracking.explain.${option}`)}
              </span>
            ))}
            lock={lockOf(tracking)}
            reset={resetOf(tracking)}
          >
            <fieldset className="ui-seg" aria-label={t(labelKey(tracking))}>
              {LINK_TRACKING.map((option) => (
                <button
                  key={option}
                  type="button"
                  data-tracking={option}
                  aria-pressed={value(tracking) === option}
                  disabled={Boolean(lockOf(tracking))}
                  onClick={() => edit(tracking, option)}
                >
                  {t(`settings.linkTracking.mode.${option}`)}
                </button>
              ))}
            </fieldset>
          </Row>
          <Row
            label={t(labelKey(linkDomain))}
            hint={t("settings.linkDomain.hint", { example: "links.example.com" })}
            htmlFor={linkDomainId}
            lock={lockOf(linkDomain)}
          >
            {field(linkDomain, linkDomainId, { className: "ui-mono", ltr: true })}
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

function WebhookRow({ set, onMade }: { set: boolean; onMade: () => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<WebhookSecretsView | null>(null)

  const make = async () => {
    if (set || made) {
      const yes = await confirmDialog({
        title: t("settings.sending.webhook.replaceTitle"),
        message: t("settings.sending.webhook.replaceMessage"),
        confirmText: t("settings.sending.webhook.replace"),
      })
      if (!yes) return
    }
    setBusy(true)
    try {
      const secrets = await api.generateWebhook()
      setMade(secrets)
      showToast(t("settings.sending.webhook.done"), "success")
      onMade()
    } catch (failure) {
      showToast(errorText(t, failure), "error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Row
        label={t("settings.sending.smtp2go.webhookPath.label")}
        hint={t("settings.sending.smtp2go.webhookPath.hint")}
      >
        <div className="ui-scanner" aria-live="polite" data-webhook={set || made ? "set" : "not-set"}>
          <span className="ui-scanner-line">
            <Tag tone={set || made ? "ok" : "neutral"}>
              {set || made ? t("settings.sending.webhook.set") : t("settings.sending.webhook.notSet")}
            </Tag>
          </span>
          <span className="ui-scanner-note">
            {made
              ? t("settings.sending.webhook.shownOnce")
              : set
                ? t("settings.sending.webhook.setNote")
                : t("settings.sending.webhook.notSetNote")}
          </span>
          {made ? (
            <span className="ui-secret" data-webhook-url="">
              <span className="ui-label">{t("settings.sending.webhook.url")}</span>{" "}
              <Copyable value={made.url} dir="ltr" />
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="ui-btn ui-btn-sm"
          disabled={busy}
          aria-busy={busy || undefined}
          data-webhook-make=""
          onClick={() => void make()}
        >
          {set || made ? t("settings.sending.webhook.replace") : t("settings.sending.webhook.generate")}
        </button>
      </Row>
      {made ? (
        <Row
          label={t("settings.sending.smtp2go.webhookToken.label")}
          hint={t("settings.sending.smtp2go.webhookToken.hint")}
        >
          <span className="ui-secret" data-webhook-token="">
            <span className="ui-label">{t("settings.sending.webhook.token")}</span>{" "}
            <Copyable value={made.token} dir="ltr" />
          </span>
        </Row>
      ) : null}
    </>
  )
}

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

export function engineOf(version: string | null): { version: string; signatures: string } | null {
  const match = version ? /^ClamAV ([^/\s]+)\/(\d+)/.exec(version) : null
  return match?.[1] && match[2] ? { version: match[1], signatures: match[2] } : null
}

export function labelKey(key: SettingKey): string {
  if (key === "general.defaultLocale") return "settings.defaultLocale.label"
  if (key === "scanner.address") return "settings.scannerAddress.label"
  if (key === "scanner.unavailablePolicy") return "settings.scannerPolicy.label"
  if (key === "scanner.scanTimeoutSeconds") return "settings.scanTimeout.label"
  if (key === "files.maxBytes") return "settings.maxBytes.label"
  if (key === "files.blockedTypes") return "settings.blockedTypes.label"
  if (key === "graph.tenantId") return "settings.graphTenant.label"
  if (key === "graph.clientId") return "settings.graphClient.label"
  if (key === "graph.clientSecret") return "settings.graphSecret.label"
  if (key === "graph.mailbox") return "settings.graphMailbox.label"
  if (key === "links.tracking") return "settings.linkTracking.label"
  if (key === "links.domain") return "settings.linkDomain.label"
  if (key.startsWith("smtp2go.") || key.startsWith("failover.") || key === "mail.bounceAddress")
    return `settings.sending.${key}.label`
  return "settings.sessionDays.label"
}
