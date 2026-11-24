// A ticket's scheduled replies (plan 4.2), above the composer: each with its time (Israel time), its author, its
// recipients, and its state. Until it starts sending, its author can change it (in the composer: a new version) and
// anyone who sees the ticket can cancel it (asked first). Once it went to the send point it shows where the reply is
// (3.1's states; the reply itself is in the conversation, marked as scheduled), and a cancelled or ended one says why:
// the agent cancelled it, the customer wrote first (the agent can write again), the ticket moved to another
// organization, or a check at its time failed. A reply still scheduled more than LATE_MS after its time shows as late:
// its job runs at its time and the worker runs it again every few minutes while it is overdue, so this much delay means
// something keeps it from going; the view says it has not gone out and the agent can cancel it and write again.

import type { ActionReason, ScheduledReplyView, TicketView } from "@maane/shared"
import { useQueryClient } from "@tanstack/react-query"
import { CalendarClock, Paperclip, Pencil, X } from "lucide-react"
import { useState } from "react"
import { api, qk } from "../../api/endpoints.ts"
import { errorText } from "../../api/errors.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { confirmDialog } from "../../ui/confirm.tsx"
import { Time } from "../../ui/Time.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tag, type Tone } from "../../ui/tags.tsx"
import { OUTBOX_TONE } from "./Delivery.tsx"
import { AddressLine } from "./parts.tsx"

export function ScheduledReplies({
  view,
  editing,
  onEdit,
}: {
  view: TicketView
  /** The scheduled reply the composer is changing now, if any. */
  editing: string | null
  onEdit: (scheduled: ScheduledReplyView) => void
}) {
  const { t } = useI18n()
  if (view.scheduled.length === 0) return null
  return (
    <section className="ui-scheduled-list" aria-labelledby="ticket-scheduled">
      <h2 className="ui-section-title" id="ticket-scheduled">
        {t("scheduled.title")}
      </h2>
      {view.scheduled.map((entry) => (
        <ScheduledCard
          key={entry.id}
          entry={entry}
          ticketNumber={view.ticket.number}
          editing={editing === entry.id}
          onEdit={() => onEdit(entry)}
        />
      ))}
    </section>
  )
}

/** How long after its time a reply still scheduled shows as late. */
const LATE_MS = 30 * 60 * 1000

/** Whether a reply is still scheduled more than LATE_MS after its time, judged when the view renders. */
function isLate(entry: Pick<ScheduledReplyView, "state" | "sendAt">, now = Date.now()): boolean {
  return entry.state === "scheduled" && now - Date.parse(entry.sendAt) > LATE_MS
}

function stateOf(entry: ScheduledReplyView): { tone: Tone; key: string } {
  if (isLate(entry)) return { tone: "fail", key: "scheduled.state.late" }
  if (entry.state === "scheduled") return { tone: "info", key: "scheduled.state.scheduled" }
  if (entry.state === "cancelled") return { tone: "neutral", key: "scheduled.state.cancelled" }
  if (entry.state === "ended") return { tone: "fail", key: "scheduled.state.ended" }
  if (entry.outboxState) return { tone: OUTBOX_TONE[entry.outboxState], key: `delivery.state.${entry.outboxState}` }
  return { tone: "info", key: "scheduled.state.handed" }
}

function ScheduledCard({
  entry,
  ticketNumber,
  editing,
  onEdit,
}: {
  entry: ScheduledReplyView
  ticketNumber: number
  editing: boolean
  onEdit: () => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  // Until it starts sending: also once its reply was written and waits for the send point, which stops it there.
  const open = entry.state === "scheduled" || entry.state === "handed"
  const late = isLate(entry)
  const state = stateOf(entry)

  const cancel = async () => {
    const yes = await confirmDialog({
      title: t("scheduled.cancelTitle"),
      message: t("scheduled.cancelMessage"),
      confirmText: t("scheduled.cancel"),
      cancelText: t("scheduled.keep"),
      danger: true,
    })
    if (!yes) return
    setBusy(true)
    try {
      await api.cancelScheduled(entry.id)
      showToast(t("scheduled.cancelDone"), "success")
    } catch (failure) {
      showToast(t("scheduled.cancelFailed", { reason: errorText(t, failure) }), "error")
    } finally {
      await queryClient.invalidateQueries({ queryKey: qk.ticket(ticketNumber) })
      setBusy(false)
    }
  }

  return (
    <article
      className="ui-panel ui-scheduled"
      data-scheduled={entry.id}
      data-state={entry.state}
      data-late={late || undefined}
      data-editing={editing || undefined}
    >
      <header className="ui-message-head">
        <span className="ui-message-from">
          <CalendarClock className="ui-scheduled-icon" aria-hidden="true" />
          <Tag tone={state.tone}>{t(state.key)}</Tag>
          {entry.author ? <bdi dir="auto">{entry.author.name}</bdi> : null}
          {editing ? <Tag tone="info">{t("scheduled.editing")}</Tag> : null}
        </span>
        <span className="ui-scheduled-when">
          <span className="ui-muted">
            {entry.state === "scheduled" && !late ? t("scheduled.goesAt") : t("scheduled.wasAt")}
          </span>
          <Time value={entry.sendAt} mode="full" />
        </span>
      </header>
      {late ? (
        <p className="ui-scheduled-reason" data-testid="scheduled-late">
          {t("scheduled.late")}
        </p>
      ) : null}
      {entry.reason ? (
        <p className="ui-scheduled-reason">{t(`scheduled.reason.${entry.reason as ActionReason}`)}</p>
      ) : null}
      {open ? (
        <>
          <dl className="ui-message-to">
            <div>
              <dt>{t("compose.from")}</dt>
              <dd>
                <bdi className="ui-mono" dir="ltr">
                  {entry.from}
                </bdi>
              </dd>
            </div>
            <div>
              <dt>{t("ticket.to")}</dt>
              <dd>
                {entry.to.map((address) => (
                  <AddressLine key={address.address} value={address} />
                ))}
              </dd>
            </div>
            {entry.cc.length > 0 ? (
              <div>
                <dt>{t("ticket.cc")}</dt>
                <dd>
                  {entry.cc.map((address) => (
                    <AddressLine key={address.address} value={address} />
                  ))}
                </dd>
              </div>
            ) : null}
          </dl>
          <div className="ui-scheduled-text">
            {entry.text.split(/\r?\n/).map((line, index) => (
              // Each line takes the direction of its first letter, as the email's paragraphs do.
              // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one fixed text, in order
              <p key={index} dir="auto">
                {line || " "}
              </p>
            ))}
          </div>
          {entry.files.length > 0 ? (
            <ul className="ui-scheduled-files" aria-label={t("compose.files")}>
              {entry.files.map((file) => (
                <li key={`${file.source}-${file.id}`}>
                  <Paperclip className="ui-scheduled-file-icon" aria-hidden="true" />
                  <bdi dir="auto">{file.fileName}</bdi>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="ui-hint">{entry.setPending ? t("scheduled.thenPending") : t("scheduled.thenStatus")}</p>
          <div className="ui-scheduled-acts">
            {entry.editable ? (
              <button type="button" className="ui-btn ui-btn-sm" disabled={busy || editing} onClick={onEdit}>
                <Pencil aria-hidden="true" />
                {t("scheduled.change")}
              </button>
            ) : null}
            <button
              type="button"
              className="ui-btn ui-btn-sm"
              disabled={busy}
              onClick={() => void cancel()}
              data-testid="scheduled-cancel"
            >
              <X aria-hidden="true" />
              {t("scheduled.cancel")}
            </button>
          </div>
        </>
      ) : null}
    </article>
  )
}
