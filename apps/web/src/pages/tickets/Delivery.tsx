// Where a reply's sending is (plan 3.1): its state, each recipient's (accepted, refused, unknown, or not sent yet) and
// the server that answered, and, when its fate is unknown or nothing went out, what the agent can do: send it again
// to the recipients not accepted, or mark one recipient whose fate is unknown as sent (each on its own: one of them
// may have been refused before the connection dropped). Both ask first: a second copy cannot be called back. Once a
// provider or a delivery report said what the recipient's server did (plan 3.3), that status shows with its time and the
// provider's reason, and a delivery event Maane could not tie to one recipient shows above the list.

import type { DeliveryStatus, DeliveryView, OutboxState, RecipientState } from "@maane/shared"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, qk } from "../../api/endpoints.ts"
import { errorText } from "../../api/errors.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { confirmDialog } from "../../ui/confirm.tsx"
import { Banner } from "../../ui/states.tsx"
import { Time } from "../../ui/Time.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tag, type Tone } from "../../ui/tags.tsx"
import { AddressLine } from "./parts.tsx"

export const OUTBOX_TONE: Record<OutboxState, Tone> = {
  pending: "info",
  sending: "info",
  accepted: "ok",
  failed: "fail",
  unknown: "warn",
}
const RECIPIENT_TONE: Record<RecipientState, Tone> = {
  pending: "neutral",
  accepted: "ok",
  refused: "fail",
  unknown: "warn",
}
/** What the recipient's server did (plan 3.3): delivered, or a bounce, a rejection, or a spam report. */
const STATUS_TONE: Record<DeliveryStatus, Tone> = {
  delivered: "ok",
  soft_bounce: "warn",
  hard_bounce: "fail",
  rejected: "fail",
  spam: "fail",
}

export function Delivery({
  messageId,
  ticketNumber,
  delivery,
}: {
  messageId: string
  ticketNumber: number
  delivery: DeliveryView
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  const act = async (action: "resend" | "markSent", address = "") => {
    const yes = await confirmDialog(
      action === "resend"
        ? {
            title: t("delivery.resendTitle"),
            message: t("delivery.resendMessage"),
            confirmText: t("delivery.resend"),
          }
        : {
            title: t("delivery.markSentTitle", { address }),
            message: t("delivery.markSentMessage"),
            confirmText: t("delivery.markSent"),
          },
    )
    if (!yes) return
    setBusy(true)
    try {
      if (action === "resend") await api.resend(messageId)
      else await api.markSent(messageId, address)
      showToast(action === "resend" ? t("delivery.resendDone") : t("delivery.markSentDone"), "success")
      await queryClient.invalidateQueries({ queryKey: qk.ticket(ticketNumber) })
    } catch (failure) {
      showToast(errorText(t, failure), "error")
    } finally {
      setBusy(false)
    }
  }

  const actions = (
    <span className="ui-delivery-acts">
      <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => void act("resend")}>
        {t("delivery.resend")}
      </button>
    </span>
  )

  return (
    <div className="ui-delivery" data-state={delivery.state}>
      <div className="ui-delivery-head">
        <span className="ui-label">{t("delivery.title")}</span>
        <Tag tone={OUTBOX_TONE[delivery.state]}>{t(`delivery.state.${delivery.state}`)}</Tag>
      </div>
      {delivery.state === "unknown" ? (
        <Banner tone="warn" title={t("delivery.unknownTitle")} action={actions}>
          {t("delivery.unknownHint")}
        </Banner>
      ) : null}
      {delivery.state === "failed" ? (
        <Banner
          tone="fail"
          title={delivery.problem ? t(`delivery.problem.${delivery.problem}`) : t("delivery.refusedAll")}
          action={actions}
        />
      ) : null}
      {delivery.unmatchedDelivery ? <Banner tone="warn" title={t("delivery.unmatched")} /> : null}
      <ul className="ui-delivery-list">
        {delivery.recipients.map((recipient) => (
          <li key={recipient.address} data-recipient={recipient.address} data-state={recipient.state}>
            <span className="ui-delivery-kind">{recipient.kind === "cc" ? t("ticket.cc") : t("ticket.to")}</span>
            <AddressLine value={recipient} />
            <Tag tone={RECIPIENT_TONE[recipient.state]}>{t(`delivery.recipient.${recipient.state}`)}</Tag>
            {recipient.provider ? (
              <span className="ui-muted">{t(`delivery.provider.${recipient.provider}`)}</span>
            ) : null}
            {recipient.marked ? <span className="ui-muted">{t("delivery.marked")}</span> : null}
            {recipient.delivery ? (
              <span className="ui-delivery-status" data-delivery={recipient.delivery}>
                <Tag tone={STATUS_TONE[recipient.delivery]}>{t(`delivery.status.${recipient.delivery}`)}</Tag>
                <Time value={recipient.deliveryAt} />
                {recipient.deliveryDetail ? (
                  <bdi className="ui-delivery-detail ui-mono" dir="ltr">
                    {recipient.deliveryDetail}
                  </bdi>
                ) : null}
              </span>
            ) : null}
            {recipient.state === "unknown" && delivery.state === "unknown" ? (
              <button
                type="button"
                className="ui-btn ui-btn-sm"
                disabled={busy}
                data-mark={recipient.address}
                onClick={() => void act("markSent", recipient.address)}
              >
                {t("delivery.markSent")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
