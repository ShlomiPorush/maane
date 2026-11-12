// The small parts the ticket list, the ticket view, and the intake log share: a ticket number, a sender, the status
// and review tags, and a scan status in words. The word is the status; its colour only reinforces it (FB-14).

import type { MailAddress, PartStatus, TicketStatus } from "@maane/shared"
import { useI18n } from "../../i18n/i18n.tsx"
import { Tag, type Tone } from "../../ui/tags.tsx"

/** The tone of each scan status: kept and clean is ok, blocked is a failure, anything not proven clean a warning. */
export const SCAN_TONE: Record<PartStatus, Tone> = {
  clean: "ok",
  infected: "fail",
  blocked_type: "fail",
  not_fully_scanned: "warn",
  waiting: "warn",
  not_scanned: "warn",
  too_large: "warn",
  unavailable: "neutral",
}

/** "#123", isolated left to right so its sign stays before the digits in a right-to-left line. */
export function TicketNumber({ number }: { number: number }) {
  return (
    <bdi className="ui-ticket-num ui-mono" dir="ltr">
      #{number}
    </bdi>
  )
}

/** A sender: the display name, or the address (in mono, left to right) when there is no name. */
export function Sender({
  sender,
  unknownKey = "tickets.unknownSender",
}: {
  sender: MailAddress | null
  unknownKey?: string
}) {
  const { t } = useI18n()
  if (!sender) return <span>{t(unknownKey)}</span>
  if (sender.name) return <bdi dir="auto">{sender.name}</bdi>
  return (
    <bdi className="ui-mono" dir="ltr">
      {sender.address}
    </bdi>
  )
}

/** A name and its address: "Dana Customer <dana@example.com>" with the address in mono, left to right. */
export function AddressLine({ value }: { value: MailAddress }) {
  return (
    <span className="ui-address">
      {value.name ? (
        <>
          <bdi dir="auto">{value.name}</bdi>{" "}
        </>
      ) : null}
      <bdi className="ui-mono ui-address-value" dir="ltr">
        {value.name ? `<${value.address}>` : value.address}
      </bdi>
    </span>
  )
}

export function TicketTags({ status, flags }: { status: TicketStatus; flags: string[] }) {
  const { t } = useI18n()
  return (
    <>
      <Tag tone={status === "new" ? "info" : "neutral"}>{t(`ticket.status.${status}`)}</Tag>
      {flags.map((flag) => (
        <Tag key={flag} tone="warn">
          {t(`flag.${flag}`)}
        </Tag>
      ))}
    </>
  )
}

export function ScanTag({ status }: { status: PartStatus }) {
  const { t } = useI18n()
  return <Tag tone={SCAN_TONE[status]}>{t(`scan.status.${status}`)}</Tag>
}
