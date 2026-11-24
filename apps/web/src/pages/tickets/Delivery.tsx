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
        <Banner tone="warn" title={t("delivery.unknownTitle")} action={delivery.reminder ? undefined : actions}>
          {delivery.reminder ? t("delivery.reminderOnce") : t("delivery.unknownHint")}
        </Banner>
      ) : null}
      {delivery.state === "failed" ? (
        <Banner
          tone="fail"
          title={delivery.problem ? t(`delivery.problem.${delivery.problem}`) : t("delivery.refusedAll")}
          action={delivery.scheduledEnded || (delivery.reminder && !delivery.reminderResend) ? undefined : actions}
        />
      ) : null}
      {delivery.unmatchedDelivery ? (
        <Banner tone="warn" title={t("delivery.unmatched")}>
          <span className="ui-delivery-status" data-unmatched={delivery.unmatchedDelivery.source}>
            {delivery.unmatchedDelivery.status ? (
              <Tag tone={STATUS_TONE[delivery.unmatchedDelivery.status]}>
                {t(`delivery.status.${delivery.unmatchedDelivery.status}`)}
              </Tag>
            ) : null}
            <Time value={delivery.unmatchedDelivery.at ?? delivery.unmatchedDelivery.recordedAt} />
            {delivery.unmatchedDelivery.recipient ? (
              <bdi className="ui-mono" dir="ltr">
                {delivery.unmatchedDelivery.recipient}
              </bdi>
            ) : null}
            {delivery.unmatchedDelivery.messageId ? (
              <bdi className="ui-delivery-detail ui-mono" dir="ltr">
                {delivery.unmatchedDelivery.messageId}
              </bdi>
            ) : null}
          </span>
        </Banner>
      ) : null}
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
