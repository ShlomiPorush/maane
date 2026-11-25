import {
  ADDRESS_KINDS,
  type AddressKind,
  ORGANIZATION_NAME_MAX,
  parseSupportAddress,
  REMINDER_DAYS_MAX,
  REMINDER_DAYS_MIN,
  REMINDER_TEMPLATE_MAX,
  SIGNATURE_MAX,
} from "@maane/shared"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Ellipsis, Pencil, Plus, Star, Trash2, UserMinus, UserPlus } from "lucide-react"
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { authClient, authData } from "../api/auth.ts"
import { ApiError } from "../api/client.ts"
import { api, type OrganizationDetail, type OrganizationMember, qk, type SupportAddress } from "../api/endpoints.ts"
import { ADDRESS_EXAMPLES, errorText } from "../api/errors.ts"
import { formatNumber } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { Copyable } from "../ui/Copyable.tsx"
import { confirmDialog, useDiscardGuard } from "../ui/confirm.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Menu, type MenuEntry } from "../ui/Menu.tsx"
import { useMounted } from "../ui/mounted.ts"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { Empty, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Tag } from "../ui/tags.tsx"
import { AdminOnly } from "./AdminOnly.tsx"
import { FormError } from "./auth/parts.tsx"
import type { ListedUser } from "./UsersPage.tsx"

export function OrganizationPage() {
  const { t } = useI18n()
  const { id = "" } = useParams()
  return (
    <AdminOnly title={t("organizations.title")}>
      <Organization key={id} />
    </AdminOnly>
  )
}

function useChange(id: string, name: string) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  return async (run: () => Promise<unknown>, done: string): Promise<boolean> => {
    try {
      await run()
      showToast(done, "success")
      return true
    } catch (error) {
      showToast(t("organization.actionFailed", { name, reason: errorText(t, error) }), "error")
      return false
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.organization(id) }),
        queryClient.invalidateQueries({ queryKey: qk.organizations, exact: true }),
      ])
    }
  }
}

function Organization() {
  const { t } = useI18n()
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const query = usePageQuery({
    queryKey: qk.organization(id),
    queryFn: () => api.organization(id),
    every: EVERY.live,
  })
  const data = query.data
  const name = data?.organization.name ?? ""
  usePageMeta(name || t("organization.loadingTitle"), [{ label: t("organizations.title"), to: "/organizations" }])
  const change = useChange(id, name)
  const mounted = useMounted()
  const [renaming, setRenaming] = useState(false)
  const [addingAddress, setAddingAddress] = useState(false)
  const [addingMember, setAddingMember] = useState(false)
  const [signing, setSigning] = useState(false)
  const [reminding, setReminding] = useState(false)

  const remove = async () => {
    if (!data) return
    if (data.addresses.length > 0 || data.members.length > 0) {
      showToast(t("organization.deleteInUse", { name }), "error")
      return
    }
    const confirmed = await confirmDialog({
      title: t("organization.deleteTitle", { name }),
      message: t("organization.deleteMessage"),
      confirmText: t("organization.delete"),
      danger: true,
    })
    if (!confirmed) return
    if ((await change(() => api.deleteOrganization(id), t("organization.deleteDone", { name }))) && mounted.current)
      navigate("/organizations")
  }

  const gone = query.error instanceof ApiError && query.error.code === "organization_not_found"
  if (!data) {
    return (
      <div className="ui-page">
        <PageHead title={t("organization.loadingTitle")} />
        <section className="ui-panel">
          {query.isPending ? <Loading label={t("organization.loading")} /> : null}
          {query.isError ? (
            <ErrorState
              title={t("organization.failed")}
              error={query.error}
              onRetry={gone ? undefined : () => void query.refetch()}
            />
          ) : null}
          {gone ? (
            <div className="ui-list-more">
              <Link className="ui-btn" to="/organizations">
                {t("organization.back")}
              </Link>
            </div>
          ) : null}
        </section>
      </div>
    )
  }

  return (
    <div className="ui-page">
      <PageHead
        title={name}
        titleDir="auto"
        description={t("organization.description")}
        actions={
          <>
            <button type="button" className="ui-btn" onClick={() => setRenaming(true)}>
              <Pencil aria-hidden="true" />
              {t("organization.rename")}
            </button>
            <button type="button" className="ui-btn ui-btn-danger" onClick={() => void remove()}>
              <Trash2 aria-hidden="true" />
              {t("organization.delete")}
            </button>
          </>
        }
      />
      <StaleNote failed={query.isError} />
      <Addresses data={data} change={change} onAdd={() => setAddingAddress(true)} />
      <Members data={data} change={change} onAdd={() => setAddingMember(true)} />
      <Signature signature={data.organization.signature} onEdit={() => setSigning(true)} />
      <Reminder
        template={data.organization.reminderTemplate}
        days={data.organization.reminderDays}
        onEdit={() => setReminding(true)}
      />
      {renaming ? <RenameDialog id={id} name={name} onClose={() => setRenaming(false)} /> : null}
      {addingAddress ? <AddAddressDialog id={id} onClose={() => setAddingAddress(false)} /> : null}
      {addingMember ? <AddMemberDialog data={data} onClose={() => setAddingMember(false)} /> : null}
      {signing ? (
        <SignatureDialog id={id} signature={data.organization.signature} onClose={() => setSigning(false)} />
      ) : null}
      {reminding ? (
        <ReminderDialog
          id={id}
          template={data.organization.reminderTemplate}
          days={data.organization.reminderDays}
          onClose={() => setReminding(false)}
        />
      ) : null}
    </div>
  )
}

type Change = ReturnType<typeof useChange>

function Signature({ signature, onEdit }: { signature: string; onEdit: () => void }) {
  const { t } = useI18n()
  return (
    <section className="ui-panel" aria-labelledby="organization-signature">
      <div className="ui-panel-head">
        <h2 id="organization-signature">{t("organization.signature.title")}</h2>
        <button type="button" className="ui-btn ui-btn-sm" onClick={onEdit}>
          <Pencil aria-hidden="true" />
          {t("organization.signature.edit")}
        </button>
      </div>
      {signature ? (
        <div className="ui-signature" data-testid="organization-signature">
          {linesOf(signature).map(({ key, line }) => (
            <div key={key} dir="auto">
              {line === "" ? <br /> : line}
            </div>
          ))}
        </div>
      ) : (
        <Empty title={t("organization.signature.empty")} hint={t("organization.signature.emptyHint")} />
      )}
    </section>
  )
}

function SignatureDialog({ id, signature, onClose }: { id: string; signature: string; onClose: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const formId = useId()
  const fieldId = useId()
  const hintId = useId()
  const mounted = useMounted()
  const [value, setValue] = useState(signature)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guardedClose = useDiscardGuard(value !== signature, onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if ([...value].length > SIGNATURE_MAX) return setError(t("organization.signature.rule", { max: SIGNATURE_MAX }))
    setBusy(true)
    setError(null)
    try {
      await api.setSignature(id, value)
      showToast(t("organization.signature.done"), "success")
      if (mounted.current) {
        guardedClose.dismiss()
        onClose()
      }
      await queryClient.invalidateQueries({ queryKey: qk.organization(id) })
    } catch (failure) {
      setError(errorText(t, failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("organization.signature.editTitle")}
      size="md"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("organization.signature.saving") : t("organization.signature.save")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <div className="ui-field">
          <label className="ui-label" htmlFor={fieldId}>
            {t("organization.signature.title")}
          </label>
          <textarea
            id={fieldId}
            className="ui-input ui-textarea"
            dir="auto"
            rows={6}
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={hintId}
            onChange={(event) => setValue(event.target.value)}
          />
          <p id={hintId} className="ui-hint">
            {t("organization.signature.hint", { max: SIGNATURE_MAX })}
          </p>
        </div>
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Dialog>
  )
}

function linesOf(text: string): { key: number; line: string }[] {
  let at = 0
  return text.split("\n").map((line) => {
    const key = at
    at += line.length + 1
    return { key, line }
  })
}

function Reminder({ template, days, onEdit }: { template: string; days: number; onEdit: () => void }) {
  const { t, tc } = useI18n()
  return (
    <section className="ui-panel" aria-labelledby="organization-reminder" data-testid="organization-reminder">
      <div className="ui-panel-head">
        <h2 id="organization-reminder">{t("organization.reminder.title")}</h2>
        <button type="button" className="ui-btn ui-btn-sm" onClick={onEdit}>
          <Pencil aria-hidden="true" />
          {t("organization.reminder.edit")}
        </button>
      </div>
      {template ? (
        <>
          <p className="ui-reminder-after">{tc("organization.reminder.after", days)}</p>
          <div className="ui-signature" data-testid="organization-reminder-text">
            {linesOf(template).map(({ key, line }) => (
              <div key={key} dir="auto">
                {line === "" ? <br /> : line}
              </div>
            ))}
          </div>
        </>
      ) : (
        <Empty title={t("organization.reminder.empty")} hint={t("organization.reminder.emptyHint")} />
      )}
    </section>
  )
}

function ReminderDialog({
  id,
  template,
  days,
  onClose,
}: {
  id: string
  template: string
  days: number
  onClose: () => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const formId = useId()
  const fieldId = useId()
  const hintId = useId()
  const daysId = useId()
  const daysHintId = useId()
  const mounted = useMounted()
  const [value, setValue] = useState(template)
  const [count, setCount] = useState(String(days))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [daysError, setDaysError] = useState(false)
  const guardedClose = useDiscardGuard(value !== template || count !== String(days), onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const text = count.trim()
    const wanted = /^[0-9]{1,3}$/.test(text) ? Number(text) : Number.NaN
    if (!(wanted >= REMINDER_DAYS_MIN && wanted <= REMINDER_DAYS_MAX)) {
      setDaysError(true)
      return setError(t("organization.reminder.daysRule", { min: REMINDER_DAYS_MIN, max: REMINDER_DAYS_MAX }))
    }
    setDaysError(false)
    if ([...value].length > REMINDER_TEMPLATE_MAX)
      return setError(t("organization.reminder.rule", { max: REMINDER_TEMPLATE_MAX }))
    setBusy(true)
    setError(null)
    try {
      await api.setReminder(id, value, wanted)
      showToast(t("organization.reminder.done"), "success")
      if (mounted.current) {
        guardedClose.dismiss()
        onClose()
      }
      await queryClient.invalidateQueries({ queryKey: qk.organization(id) })
    } catch (failure) {
      setError(errorText(t, failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("organization.reminder.editTitle")}
      size="md"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("organization.reminder.saving") : t("organization.reminder.save")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <div className="ui-field">
          <label className="ui-label" htmlFor={fieldId}>
            {t("organization.reminder.template")}
          </label>
          <textarea
            id={fieldId}
            className="ui-input ui-textarea"
            dir="auto"
            rows={6}
            value={value}
            aria-describedby={hintId}
            onChange={(event) => setValue(event.target.value)}
          />
          <p id={hintId} className="ui-hint">
            {t("organization.reminder.templateHint", { max: REMINDER_TEMPLATE_MAX })}
          </p>
        </div>
        <div className="ui-field">
          <label className="ui-label" htmlFor={daysId}>
            {t("organization.reminder.days")}
          </label>
          <input
            id={daysId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            maxLength={3}
            data-field="days"
            className="ui-input ui-mono ui-input-days"
            dir="ltr"
            value={count}
            aria-invalid={daysError ? true : undefined}
            aria-describedby={daysHintId}
            onChange={(event) => setCount(event.target.value)}
          />
          <p id={daysHintId} className="ui-hint">
            {t("organization.reminder.daysHint", { min: REMINDER_DAYS_MIN, max: REMINDER_DAYS_MAX })}
          </p>
        </div>
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Dialog>
  )
}

function Addresses({ data, change, onAdd }: { data: OrganizationDetail; change: Change; onAdd: () => void }) {
  const { t } = useI18n()
  return (
    <section className="ui-panel" aria-labelledby="addresses-title">
      <div className="ui-panel-head">
        <h2 id="addresses-title">{t("organization.addresses.title")}</h2>
        <span className="ui-count">{formatNumber(data.addresses.length)}</span>
        <div className="ui-panel-acts">
          <button type="button" className="ui-btn ui-btn-sm" onClick={onAdd}>
            <Plus aria-hidden="true" />
            {t("organization.addresses.add")}
          </button>
        </div>
      </div>
      {data.addresses.length === 0 ? (
        <Empty title={t("organization.addresses.empty")} hint={t("organization.addresses.emptyHint")} />
      ) : null}
      {data.addresses.map((address) => (
        <AddressRow key={address.id} organizationId={data.organization.id} address={address} change={change} />
      ))}
    </section>
  )
}

function AddressRow({
  organizationId,
  address,
  change,
}: {
  organizationId: string
  address: SupportAddress
  change: Change
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const value = address.value
  const entries: MenuEntry[] = []
  if (address.kind === "exact" && !address.isDefault)
    entries.push({
      kind: "item",
      label: t("organization.addresses.setDefault"),
      icon: <Star aria-hidden="true" />,
      onSelect: () =>
        void change(
          () => api.setDefaultAddress(organizationId, address.id),
          t("organization.addresses.setDefaultDone", { value }),
        ),
    })
  entries.push({
    kind: "item",
    label: t("organization.addresses.remove"),
    icon: <Trash2 aria-hidden="true" />,
    danger: true,
    onSelect: () =>
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("organization.addresses.removeTitle", { value }),
          message: t("organization.addresses.removeMessage"),
          confirmText: t("organization.addresses.remove"),
          danger: true,
        })
        if (confirmed)
          await change(
            () => api.removeAddress(organizationId, address.id),
            t("organization.addresses.removeDone", { value }),
          )
      })(),
  })

  return (
    <div className="ui-item" data-address={value} data-tone={address.isDefault ? "info" : undefined}>
      <div className="ui-item-main">
        <span className="ui-item-title ui-item-tags">
          <Copyable value={value} dir="ltr" />
          <Tag tone="neutral">{t(`organization.kind.${address.kind}`)}</Tag>
          {address.isDefault ? <Tag tone="info">{t("organization.addresses.default")}</Tag> : null}
        </span>
        <span className="ui-item-meta">
          {address.isDefault ? (
            <span>{t("organization.addresses.defaultHint")}</span>
          ) : (
            <span>
              {t("organization.addresses.added")} <Time value={address.createdAt} mode="full" />
            </span>
          )}
        </span>
      </div>
      <div className="ui-item-end">
        <button
          ref={button}
          type="button"
          className="ui-icon-btn"
          aria-label={t("organization.addresses.actions", { value })}
          title={t("organization.addresses.actions", { value })}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <Ellipsis aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <Menu
          anchor={button}
          label={t("organization.addresses.actions", { value })}
          side="bottom"
          align="end"
          entries={entries}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  )
}

function Members({ data, change, onAdd }: { data: OrganizationDetail; change: Change; onAdd: () => void }) {
  const { t } = useI18n()
  return (
    <section className="ui-panel" aria-labelledby="members-title">
      <div className="ui-panel-head">
        <h2 id="members-title">{t("organization.members.title")}</h2>
        <span className="ui-count">{formatNumber(data.members.length)}</span>
        <div className="ui-panel-acts">
          <button type="button" className="ui-btn ui-btn-sm" onClick={onAdd}>
            <UserPlus aria-hidden="true" />
            {t("organization.members.add")}
          </button>
        </div>
      </div>
      <p className="ui-panel-intro">{t("organization.members.intro")}</p>
      {data.members.length === 0 ? (
        <Empty title={t("organization.members.empty")} hint={t("organization.members.emptyHint")} />
      ) : null}
      {data.members.map((member) => (
        <MemberRow key={member.userId} organization={data.organization} member={member} change={change} />
      ))}
    </section>
  )
}

function MemberRow({
  organization,
  member,
  change,
}: {
  organization: OrganizationDetail["organization"]
  member: OrganizationMember
  change: Change
}) {
  const { t } = useI18n()
  const name = member.username
  const remove = async () => {
    const confirmed = await confirmDialog({
      title: t("organization.members.removeTitle", { name, organization: organization.name }),
      message: t("organization.members.removeMessage"),
      confirmText: t("organization.members.remove", { name }),
      danger: true,
    })
    if (confirmed)
      await change(
        () => api.removeMember(organization.id, member.userId),
        t("organization.members.removeDone", { name }),
      )
  }
  return (
    <div className="ui-item" data-member={name}>
      <div className="ui-item-main">
        <span className="ui-item-title ui-item-tags">
          <bdi className="ui-mono" dir="ltr">
            {name}
          </bdi>
          {member.role === "admin" ? <Tag tone="neutral">{t("role.admin")}</Tag> : null}
          {member.banned ? <Tag tone="fail">{t("organization.members.disabled")}</Tag> : null}
        </span>
        <span className="ui-item-meta">
          {t("organization.members.added")} <Time value={member.createdAt} mode="full" />
        </span>
      </div>
      <div className="ui-item-end">
        <button
          type="button"
          className="ui-icon-btn"
          aria-label={t("organization.members.remove", { name })}
          title={t("organization.members.remove", { name })}
          onClick={() => void remove()}
        >
          <UserMinus aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

function RenameDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const formId = useId()
  const nameId = useId()
  const hintId = useId()
  const mounted = useMounted()
  const [value, setValue] = useState(name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guardedClose = useDiscardGuard(value !== name, onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = value.trim()
    if (trimmed.length === 0 || [...trimmed].length > ORGANIZATION_NAME_MAX)
      return setError(t("organizations.nameRule", { max: ORGANIZATION_NAME_MAX }))
    setBusy(true)
    setError(null)
    try {
      await api.renameOrganization(id, trimmed)
      showToast(t("organization.renameDone", { name: trimmed }), "success")
      if (mounted.current) {
        guardedClose.dismiss()
        onClose()
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.organization(id) }),
        queryClient.invalidateQueries({ queryKey: qk.organizations, exact: true }),
      ])
    } catch (failure) {
      setError(errorText(t, failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("organization.renameTitle", { name })}
      size="sm"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("organization.renaming") : t("organization.rename")}
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
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={hintId}
            onChange={(event) => setValue(event.target.value)}
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

function AddAddressDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const formId = useId()
  const valueId = useId()
  const hintId = useId()
  const valueRef = useRef<HTMLInputElement>(null)
  const mounted = useMounted()
  const [kind, setKind] = useState<AddressKind>("exact")
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guardedClose = useDiscardGuard(Boolean(value), onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const parsed = parseSupportAddress(kind, value)
    if (!parsed.ok) {
      setError(errorText(t, new ApiError(400, parsed.code)))
      valueRef.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.addAddress(id, kind, parsed.value)
      showToast(t("organization.addresses.addDone", { value: parsed.value }), "success")
      if (mounted.current) {
        guardedClose.dismiss()
        onClose()
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.organization(id) }),
        queryClient.invalidateQueries({ queryKey: qk.organizations, exact: true }),
      ])
    } catch (failure) {
      setError(errorText(t, failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("organization.addresses.addTitle")}
      size="sm"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("organization.addresses.adding") : t("organization.addresses.add")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <fieldset className="ui-field ui-choice">
          <legend className="ui-label">{t("organization.addresses.kind")}</legend>
          {ADDRESS_KINDS.map((option) => (
            <label key={option} className="ui-check-label">
              <input
                type="radio"
                name={`${formId}-kind`}
                className="ui-check"
                value={option}
                checked={kind === option}
                onChange={() => {
                  setKind(option)
                  setError(null)
                }}
              />
              <span>
                <b>{t(`organization.kind.${option}`)}</b>{" "}
                <span className="ui-hint">{t(`organization.kindHint.${option}`, ADDRESS_EXAMPLES)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="ui-field">
          <label className="ui-label" htmlFor={valueId}>
            {t("organization.addresses.value")}
          </label>
          <input
            id={valueId}
            ref={valueRef}
            className="ui-input"
            type="text"
            inputMode="email"
            dir="ltr"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={kind === "exact" ? ADDRESS_EXAMPLES.addressExample : ADDRESS_EXAMPLES.patternExample}
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={hintId}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
          />
          <p id={hintId} className="ui-hint">
            {t(`organization.kindHint.${kind}`, ADDRESS_EXAMPLES)}
          </p>
        </div>
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Dialog>
  )
}

const AGENT_LIMIT = 1000

function everyAgent(): Promise<{ users: ListedUser[] }> {
  return authData(
    authClient.admin.listUsers({
      query: {
        limit: AGENT_LIMIT,
        sortBy: "username",
        sortDirection: "asc",
        filterField: "role",
        filterValue: "agent",
        filterOperator: "eq",
      },
    }),
  ) as Promise<{ users: ListedUser[] }>
}

function AddMemberDialog({ data, onClose }: { data: OrganizationDetail; onClose: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const mounted = useMounted()
  const formId = useId()
  const searchId = useId()
  const [typed, setTyped] = useState("")
  const [userId, setUserId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const found = useQuery({ queryKey: ["agents"], queryFn: everyAgent, staleTime: EVERY.live })
  const search = typed.trim().toLowerCase()
  const present = new Set(data.members.map((member) => member.userId))
  const everyone = found.data?.users ?? []
  const matching = everyone.filter((user) => (user.username ?? user.name).toLowerCase().includes(search))
  const agents = matching.filter((user) => !present.has(user.id))
  const chosen = agents.find((agent) => agent.id === userId)
  const name = data.organization.name

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!chosen) return
    setBusy(true)
    setError(null)
    try {
      await api.addMember(data.organization.id, chosen.id)
      showToast(t("organization.members.addDone", { name: chosen.username ?? chosen.name }), "success")
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.organization(data.organization.id) }),
        queryClient.invalidateQueries({ queryKey: qk.organizations, exact: true }),
      ])
      if (mounted.current) onClose()
    } catch (failure) {
      setError(errorText(t, failure))
    } finally {
      setBusy(false)
    }
  }

  let list: ReactNode = null
  if (found.isPending) list = <Loading label={t("organization.members.loadingAgents")} />
  else if (found.isError && !found.data)
    list = <ErrorState title={t("users.failed")} error={found.error} onRetry={() => void found.refetch()} />
  else if (everyone.length === 0)
    list = (
      <div className="ui-form-stack">
        <p className="ui-hint">{t("organization.members.noAgents")}</p>
        <Link className="ui-btn" to="/users" replace>
          {t("organization.members.toUsers")}
        </Link>
      </div>
    )
  else if (matching.length === 0) list = <p className="ui-hint">{t("organization.members.noMatch", { search })}</p>
  else if (agents.length === 0) list = <p className="ui-hint">{t("organization.members.allMembers")}</p>
  else
    list = (
      <fieldset className="ui-field ui-choice">
        <legend className="ui-label">{t("organization.members.choose")}</legend>
        {agents.map((agent) => (
          <label key={agent.id} className="ui-check-label">
            <input
              type="radio"
              name={`${formId}-agent`}
              className="ui-check"
              value={agent.id}
              checked={userId === agent.id}
              onChange={() => {
                setUserId(agent.id)
                setError(null)
              }}
            />
            <span>
              <bdi className="ui-mono" dir="ltr">
                {agent.username ?? agent.name}
              </bdi>{" "}
              {agent.banned ? <Tag tone="fail">{t("organization.members.disabled")}</Tag> : null}
            </span>
          </label>
        ))}
      </fieldset>
    )

  return (
    <Dialog
      title={t("organization.members.addTitle", { name })}
      size="sm"
      onClose={onClose}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy || !chosen}>
          {busy ? t("organization.members.adding") : t("organization.members.add")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <div className="ui-field">
          <label className="ui-label" htmlFor={searchId}>
            {t("organization.members.search")}
          </label>
          <input
            id={searchId}
            className="ui-input"
            type="search"
            dir="ltr"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        {list}
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Dialog>
  )
}
