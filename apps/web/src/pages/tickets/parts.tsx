import type { MailAddress, PartStatus, TicketStatus } from "@maane/shared"
import { formatListTime } from "../../format/datetime.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { Tag, type Tone } from "../../ui/tags.tsx"

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

export function TicketNumber({ number }: { number: number }) {
  return (
    <bdi className="ui-ticket-num ui-mono" dir="ltr">
      #{number}
    </bdi>
  )
}

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

export function TicketTags({
  status,
  flags,
  snoozedUntil = null,
}: {
  status: TicketStatus
  flags: string[]
  snoozedUntil?: string | null
}) {
  const { t } = useI18n()
  return (
    <>
      <Tag tone={status === "new" ? "info" : status === "solved" ? "ok" : "neutral"}>
        {t(`ticket.status.${status}`)}
      </Tag>
      {snoozedUntil ? <Tag tone="info">{t("ticket.snooze.tag", { time: formatListTime(snoozedUntil) })}</Tag> : null}
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
