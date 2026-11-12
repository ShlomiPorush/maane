// A time on screen: a <time datetime> written by the format helpers, with the exact time in its tooltip
// (v3 FW-1, FW-9). The mode decides how much of it the place shows.

import { agoParts, formatListTime, formatTime, toDate } from "../format/datetime.ts"
import { useI18n } from "../i18n/i18n.tsx"

type Mode = "list" | "full" | "ago"

export function Time({ value, mode = "list" }: { value: string | null | undefined; mode?: Mode }) {
  const { t, tc } = useI18n()
  const date = toDate(value)
  if (!date) return <span className="ui-muted">-</span>
  let text: string
  if (mode === "ago") {
    const ago = agoParts(date)
    text = !ago ? "-" : ago.unit === "now" ? t("time.justNow") : tc(`time.ago.${ago.unit}`, ago.count)
  } else {
    text = mode === "list" ? formatListTime(date) : formatTime(date, { seconds: false })
  }
  return (
    // Digits keep their order inside a right-to-left sentence; "3 h ago" is a sentence of its own.
    <time
      className="ui-time"
      dir={mode === "ago" ? undefined : "ltr"}
      dateTime={date.toISOString()}
      title={formatTime(date)}
    >
      {text}
    </time>
  )
}
