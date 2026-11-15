// What an agent changes on a ticket from its page (plan 4.1): the status (a select that saves at once; `closed` is set
// and left only by an admin, so an agent sees it locked with the reason), the categories (a dialog of checkboxes), and
// the organization (a dialog that moves the ticket to another organization the user may move it to); and (plan 4.2)
// its snooze: until a date and time in Israel time, changed or ended by hand. The server decides every change again;
// these only offer what it allows.

import { mayChangeStatus, TICKET_STATUSES, type TicketStatus, type TicketView } from "@maane/shared"
import { useQueryClient } from "@tanstack/react-query"
import { AlarmClock, ArrowRightLeft, Pencil } from "lucide-react"
import { type FormEvent, useId, useState } from "react"
import { api, qk } from "../../api/endpoints.ts"
import { errorText } from "../../api/errors.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { useMe } from "../../shell/session.ts"
import { useDiscardGuard } from "../../ui/confirm.tsx"
import { Dialog } from "../../ui/Dialog.tsx"
import { useMounted } from "../../ui/mounted.ts"
import { Time } from "../../ui/Time.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tag } from "../../ui/tags.tsx"
import { FormError } from "../auth/parts.tsx"
import { WhenDialog } from "./When.tsx"

/** Reads the ticket and the lists again after a change. */
function useRefresh(number: number) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.ticket(number) }),
      queryClient.invalidateQueries({ queryKey: ["tickets"] }),
    ])
}

/** The status: saved as soon as it is chosen. */
export function StatusControl({ view }: { view: TicketView }) {
  const { t } = useI18n()
  const role = useMe().data?.role ?? "agent"
  const refresh = useRefresh(view.ticket.number)
  const hintId = useId()
  const [busy, setBusy] = useState(false)
  const current = view.ticket.status
  const locked = !mayChangeStatus(role, current, current === "closed" ? "open" : current)

  const choose = async (status: TicketStatus) => {
    if (status === current) return
    setBusy(true)
    try {
      await api.setStatus(view.ticket.number, status)
      showToast(t("ticket.statusDone", { status: t(`ticket.status.${status}`) }), "success")
    } catch (error) {
      showToast(t("ticket.statusFailed", { reason: errorText(t, error) }), "error")
    } finally {
      await refresh()
      setBusy(false)
    }
  }

  return (
    <div className="ui-workflow-field">
      <select
        className="ui-input ui-select ui-status-select"
        aria-label={t("ticket.statusLabel")}
        aria-describedby={locked ? hintId : undefined}
        data-testid="ticket-status"
        data-status={current}
        value={current}
        disabled={busy || locked}
        aria-busy={busy || undefined}
        onChange={(event) => void choose(event.target.value as TicketStatus)}
      >
        {TICKET_STATUSES.map((status) => (
          <option key={status} value={status} disabled={!mayChangeStatus(role, current, status)}>
            {mayChangeStatus(role, current, status)
              ? t(`ticket.status.${status}`)
              : t("ticket.statusAdminOnly", { status: t(`ticket.status.${status}`) })}
          </option>
        ))}
      </select>
      {locked ? (
        <p id={hintId} className="ui-hint">
          {t("ticket.statusClosedHint")}
        </p>
      ) : null}
    </div>
  )
}

/** The ticket's categories, and the dialog that changes them. */
export function CategoriesControl({ view }: { view: TicketView }) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const own = view.ticket.categories
  return (
    <div className="ui-workflow-field ui-workflow-inline">
      {own.length > 0 ? (
        <span className="ui-facts-list" data-testid="ticket-categories">
          {own.map((category) => (
            <bdi key={category.id} dir="auto">
              <Tag tone="neutral">{category.name}</Tag>
            </bdi>
          ))}
        </span>
      ) : (
        <span className="ui-muted">{t("ticket.categories.none")}</span>
      )}
      {view.categories.length > 0 ? (
        <button type="button" className="ui-btn ui-btn-sm" onClick={() => setEditing(true)}>
          <Pencil aria-hidden="true" />
          {t("ticket.categories.edit")}
        </button>
      ) : (
        <span className="ui-hint">{t("ticket.categories.noneYet")}</span>
      )}
      {editing ? <CategoriesDialog view={view} onClose={() => setEditing(false)} /> : null}
    </div>
  )
}

function CategoriesDialog({ view, onClose }: { view: TicketView; onClose: () => void }) {
  const { t } = useI18n()
  const refresh = useRefresh(view.ticket.number)
  const mounted = useMounted()
  const formId = useId()
  const initial = view.ticket.categories.map((category) => category.id)
  const [chosen, setChosen] = useState<string[]>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = chosen.length !== initial.length || chosen.some((id) => !initial.includes(id))
  const guardedClose = useDiscardGuard(changed, onClose)

  const toggle = (id: string) =>
    setChosen((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.setTicketCategories(view.ticket.number, chosen)
      showToast(t("ticket.categories.done"), "success")
      await refresh()
      if (!mounted.current) return
      guardedClose.dismiss()
      onClose()
    } catch (failure) {
      setError(errorText(t, failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("ticket.categories.title")}
      size="sm"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("ticket.saving") : t("ticket.categories.save")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <fieldset className="ui-check-list">
          <legend className="ui-label">{t("ticket.categories.label")}</legend>
          {view.categories.map((category) => (
            <label key={category.id} className="ui-check-label">
              <input
                type="checkbox"
                className="ui-check"
                checked={chosen.includes(category.id)}
                onChange={() => toggle(category.id)}
              />
              <bdi dir="auto">{category.name}</bdi>
            </label>
          ))}
        </fieldset>
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Dialog>
  )
}

/** The snooze: until when (Israel time), and Snooze, Change, End snooze. */
export function SnoozeControl({ view }: { view: TicketView }) {
  const { t } = useI18n()
  const refresh = useRefresh(view.ticket.number)
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const until = view.ticket.snoozedUntil

  const wake = async () => {
    setBusy(true)
    try {
      await api.wake(view.ticket.number)
      showToast(t("ticket.snooze.ended"), "success")
    } catch (error) {
      showToast(t("ticket.snooze.failed", { reason: errorText(t, error) }), "error")
    } finally {
      await refresh()
      setBusy(false)
    }
  }

  return (
    <div
      className="ui-workflow-field ui-workflow-inline"
      data-testid="ticket-snooze"
      data-snoozed={until ? "" : undefined}
    >
      {until ? (
        <span className="ui-snooze-until">
          <Tag tone="info">{t("ticket.snooze.snoozed")}</Tag>
          <span className="ui-muted">{t("ticket.snooze.until")}</span>
          <Time value={until} mode="full" />
        </span>
      ) : (
        <span className="ui-muted">{t("ticket.snooze.none")}</span>
      )}
      <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => setChoosing(true)}>
        <AlarmClock aria-hidden="true" />
        {until ? t("ticket.snooze.change") : t("ticket.snooze.open")}
      </button>
      {/* Also for a snooze whose time passed and whose end is late: the agent need not wait for it. */}
      {until || view.ticket.snoozeOverdue ? (
        <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => void wake()}>
          {t("ticket.snooze.end")}
        </button>
      ) : null}
      {choosing ? (
        <WhenDialog
          title={t("ticket.snooze.title", { number: view.ticket.number })}
          submitLabel={t("ticket.snooze.submit")}
          busyLabel={t("ticket.saving")}
          initial={until ?? undefined}
          onSubmit={async (at) => {
            await api.snooze(view.ticket.number, at.toISOString())
            showToast(t("ticket.snooze.done"), "success")
            await refresh()
          }}
          onClose={() => setChoosing(false)}
          testId="snooze-when"
        >
          <p className="ui-hint">{t("ticket.snooze.hint")}</p>
        </WhenDialog>
      ) : null}
    </div>
  )
}

/** The organization, and the dialog that moves the ticket when the user may. */
export function OrganizationControl({ view }: { view: TicketView }) {
  const { t } = useI18n()
  const [moving, setMoving] = useState(false)
  return (
    <div className="ui-workflow-field ui-workflow-inline">
      <bdi dir="auto">{view.ticket.organization.name}</bdi>
      {view.moveTargets.length > 0 ? (
        <button type="button" className="ui-btn ui-btn-sm" onClick={() => setMoving(true)}>
          <ArrowRightLeft aria-hidden="true" />
          {t("ticket.move.open")}
        </button>
      ) : null}
      {moving ? <MoveDialog view={view} onClose={() => setMoving(false)} /> : null}
    </div>
  )
}

function MoveDialog({ view, onClose }: { view: TicketView; onClose: () => void }) {
  const { t } = useI18n()
  const refresh = useRefresh(view.ticket.number)
  const mounted = useMounted()
  const formId = useId()
  const selectId = useId()
  const hintId = useId()
  const [target, setTarget] = useState(view.moveTargets[0]?.id ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const to = view.moveTargets.find((organization) => organization.id === target)
    if (!to) return
    setBusy(true)
    setError(null)
    try {
      await api.moveTicket(view.ticket.number, to.id)
      showToast(t("ticket.move.done", { name: to.name }), "success")
      await refresh()
      if (!mounted.current) return
      onClose()
    } catch (failure) {
      setError(errorText(t, failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("ticket.move.title", { number: view.ticket.number })}
      size="sm"
      onClose={onClose}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy || !target}>
          {busy ? t("ticket.move.moving") : t("ticket.move.submit")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <div className="ui-field">
          <label className="ui-label" htmlFor={selectId}>
            {t("ticket.move.to")}
          </label>
          <select
            id={selectId}
            className="ui-input ui-select"
            value={target}
            aria-describedby={hintId}
            onChange={(event) => setTarget(event.target.value)}
          >
            {view.moveTargets.map((organization) => (
              <option key={organization.id} value={organization.id} dir="auto">
                {organization.name}
              </option>
            ))}
          </select>
          <p id={hintId} className="ui-hint">
            {t("ticket.move.hint", { name: view.ticket.organization.name })}
          </p>
        </div>
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Dialog>
  )
}
