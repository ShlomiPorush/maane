// Organizations, /organizations, admins only (plan 2.1): every organization Maane answers for, with how many support
// addresses and agents each has and which one holds the default address (GET /api/v1/admin/organizations). A row
// opens the organization (/organizations/:id). Add organization asks for a name and opens the new organization. The
// panel "Which organization gets this address?" asks the server, which answers with the same function the intake
// uses: an exact address first, then the most specific pattern, then the default address.

import { ORGANIZATION_NAME_MAX, parseExactAddress } from "@maane/shared"
import { useQueryClient } from "@tanstack/react-query"
import { ChevronRight, Plus } from "lucide-react"
import { type FormEvent, useId, useRef, useState } from "react"
import { Link, useNavigate } from "react-router"
import { ApiError } from "../api/client.ts"
import { type AddressCheck, api, type OrganizationSummary, qk } from "../api/endpoints.ts"
import { errorText } from "../api/errors.ts"
import { formatNumber } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { useDiscardGuard } from "../ui/confirm.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { Banner, Empty, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Tag } from "../ui/tags.tsx"
import { AdminOnly } from "./AdminOnly.tsx"
import { FormError } from "./auth/parts.tsx"

export function OrganizationsPage() {
  const { t } = useI18n()
  return (
    <AdminOnly title={t("organizations.title")}>
      <Organizations />
    </AdminOnly>
  )
}

function Organizations() {
  const { t } = useI18n()
  usePageMeta(t("organizations.title"))
  const query = usePageQuery({ queryKey: qk.organizations, queryFn: api.organizations, every: EVERY.live })
  const [creating, setCreating] = useState(false)
  const organizations = query.data?.organizations ?? []

  return (
    <div className="ui-page">
      <PageHead
        title={t("organizations.title")}
        description={t("organizations.description")}
        actions={
          <button type="button" className="ui-btn ui-btn-primary" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            {t("organizations.create")}
          </button>
        }
      />
      <section className="ui-panel" aria-labelledby="organizations-title">
        <div className="ui-panel-head">
          <h2 id="organizations-title">{t("organizations.listTitle")}</h2>
          {query.data ? <span className="ui-count">{formatNumber(organizations.length)}</span> : null}
        </div>
        {query.isPending ? <Loading label={t("organizations.loading")} /> : null}
        {query.isError && !query.data ? (
          <ErrorState title={t("organizations.failed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        <StaleNote failed={query.isError && Boolean(query.data)} />
        {query.data && organizations.length === 0 ? (
          <Empty title={t("organizations.empty")} hint={t("organizations.emptyHint")} />
        ) : null}
        {organizations.map((organization) => (
          <OrganizationRow key={organization.id} organization={organization} />
        ))}
      </section>
      <AddressCheckPanel />
      {creating ? <CreateOrganizationDialog onClose={() => setCreating(false)} /> : null}
    </div>
  )
}

/** The whole row is the link to the organization (TB-8); it holds no control of its own. */
function OrganizationRow({ organization }: { organization: OrganizationSummary }) {
  const { t, tc } = useI18n()
  return (
    <Link
      to={`/organizations/${organization.id}`}
      className="ui-item ui-item-link"
      data-row-open=""
      data-organization={organization.name}
    >
      <span className="ui-item-main">
        <span className="ui-item-title">
          <bdi dir="auto">{organization.name}</bdi>
        </span>
        <span className="ui-item-meta">
          <span>{tc("organizations.addressCount", organization.addresses)}</span>
          <span aria-hidden="true">·</span>
          <span>{tc("organizations.memberCount", organization.members)}</span>
        </span>
      </span>
      <span className="ui-item-end">
        {organization.hasDefault ? <Tag tone="info">{t("organizations.holdsDefault")}</Tag> : null}
        <ChevronRight className="ui-item-chevron" aria-hidden="true" />
      </span>
    </Link>
  )
}

/** A name for a new organization; once added, its page opens so its addresses and agents can be added. */
function CreateOrganizationDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const formId = useId()
  const nameId = useId()
  const hintId = useId()
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guardedClose = useDiscardGuard(Boolean(name), onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length === 0 || [...trimmed].length > ORGANIZATION_NAME_MAX)
      return setError(t("organizations.nameRule", { max: ORGANIZATION_NAME_MAX }))
    setBusy(true)
    setError(null)
    try {
      const { organization } = await api.createOrganization(trimmed)
      guardedClose.dismiss()
      onClose()
      showToast(t("organizations.createDone", { name: organization.name }), "success")
      await queryClient.invalidateQueries({ queryKey: qk.organizations })
      navigate(`/organizations/${organization.id}`)
    } catch (failure) {
      setError(errorText(t, failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("organizations.createTitle")}
      size="sm"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("organizations.creating") : t("organizations.create")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <div className="ui-field">
          <label className="ui-label" htmlFor={nameId}>
            {t("organizations.name")}
          </label>
          <input
            id={nameId}
            className="ui-input"
            dir="auto"
            autoComplete="off"
            maxLength={ORGANIZATION_NAME_MAX * 2}
            value={name}
            aria-invalid={error ? true : undefined}
            aria-describedby={hintId}
            onChange={(event) => setName(event.target.value)}
          />
          <p id={hintId} className="ui-hint">
            {t("organizations.nameRule", { max: ORGANIZATION_NAME_MAX })}
          </p>
        </div>
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Dialog>
  )
}

/** "Which organization gets this address?": the server's answer, from the same function the intake uses. */
function AddressCheckPanel() {
  const { t } = useI18n()
  const inputId = useId()
  const hintId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [address, setAddress] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AddressCheck | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!parseExactAddress(address).ok) {
      setResult(null)
      setError(errorText(t, new ApiError(400, "address_invalid")))
      input.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      setResult(await api.checkAddress(address))
    } catch (failure) {
      setResult(null)
      setError(errorText(t, failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ui-panel" aria-labelledby="address-check-title">
      <div className="ui-panel-head">
        <h2 id="address-check-title">{t("organizations.check.title")}</h2>
      </div>
      <p className="ui-panel-intro" id={hintId}>
        {t("organizations.check.hint")}
      </p>
      <form className="ui-check-form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="ui-sr-only" htmlFor={inputId}>
          {t("organizations.check.label")}
        </label>
        <input
          id={inputId}
          ref={input}
          className="ui-input ui-check-input"
          type="text"
          inputMode="email"
          dir="ltr"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="support@example.com"
          value={address}
          aria-invalid={error ? true : undefined}
          aria-describedby={hintId}
          onChange={(event) => {
            setAddress(event.target.value)
            setError(null)
          }}
        />
        <button type="submit" className="ui-btn" disabled={busy}>
          {busy ? t("organizations.check.checking") : t("organizations.check.submit")}
        </button>
      </form>
      <div className="ui-check-result" aria-live="polite">
        {error ? <FormError>{error}</FormError> : null}
        {result ? <CheckResult result={result} /> : null}
      </div>
    </section>
  )
}

function CheckResult({ result }: { result: AddressCheck }) {
  const { t } = useI18n()
  if (result.via === "none" || !result.organization || !result.rule)
    return (
      <Banner tone="warn" title={<AddressText value={result.address} />}>
        {t("organizations.check.none")}
      </Banner>
    )
  const { organization, rule } = result
  return (
    <Banner
      tone="info"
      title={<AddressText value={result.address} />}
      action={
        <Link className="ui-btn ui-btn-sm" to={`/organizations/${organization.id}`}>
          {t("organizations.check.open", { name: organization.name })}
        </Link>
      }
    >
      {t(`organizations.check.${result.via}`, { organization: organization.name, rule: rule.value })}
    </Banner>
  )
}

/** An address or pattern: mono, isolated left to right inside a right-to-left page. */
export function AddressText({ value }: { value: string }) {
  return (
    <bdi className="ui-mono" dir="ltr">
      {value}
    </bdi>
  )
}
