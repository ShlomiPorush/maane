import type { ReminderView } from "@maane/shared"
import { BellRing } from "lucide-react"
import { useI18n } from "../../i18n/i18n.tsx"
import { Time } from "../../ui/Time.tsx"
import { Tag } from "../../ui/tags.tsx"

export function PendingReminder({ reminder }: { reminder: ReminderView }) {
  const { t } = useI18n()
  const going = reminder.state === "handed"
  return (
    <section
      className="ui-panel ui-scheduled ui-reminder"
      aria-labelledby="ticket-reminder"
      data-testid="ticket-reminder"
      data-state={reminder.state}
    >
      <header className="ui-message-head">
        <span className="ui-message-from">
          <BellRing className="ui-scheduled-icon" aria-hidden="true" />
          <h2 className="ui-reminder-title" id="ticket-reminder">
            {t("reminder.title")}
          </h2>
          {going ? <Tag tone="info">{t("reminder.going")}</Tag> : null}
        </span>
        <span className="ui-scheduled-when">
          <span className="ui-muted">{t("reminder.goesAt")}</span>
          <Time value={reminder.dueAt} mode="full" />
        </span>
      </header>
      <p className="ui-scheduled-reason">{t("reminder.hint")}</p>
    </section>
  )
}
