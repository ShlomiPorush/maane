// Choosing a time ahead in Israel time (plan 4.2): "send later" in the composer and snooze. The date and the time are
// entered and shown in Maane's zone (Asia/Jerusalem) whatever the browser's zone (format/datetime.ts converts them,
// daylight saving included). The date is the browser's date field (its order is the browser's, v3 FW-9); the time is
// typed on the 24-hour clock, since a native time field shows AM and PM in some browsers' languages. A time the clock
// skips when summer time starts is refused with the reason, and so is a time that is not ahead; the server refuses one
// that is not ahead by its own clock too.

import { type FormEvent, type ReactNode, useId, useState } from "react"
import { errorText } from "../../api/errors.ts"
import { nextWholeHour, type ZonedInput, zonedInput, zonedInstant } from "../../format/datetime.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { useDiscardGuard } from "../../ui/confirm.tsx"
import { Dialog } from "../../ui/Dialog.tsx"
import { useMounted } from "../../ui/mounted.ts"
import { FormError } from "../auth/parts.tsx"

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** The time as typed on the 24-hour clock (v3 FW-9): "9:30" or "09:30". */
const TIME = /^(\d{1,2}):(\d{2})$/

export function WhenDialog(props: {
  title: string
  submitLabel: string
  busyLabel: string
  /** Where the fields start: an instant (a change), else the next whole hour. */
  initial?: string
  /** More fields under the time (the composer's status action). */
  children?: ReactNode
  /** Does the work with the chosen instant; a refusal stays in the dialog with its words. */
  onSubmit: (at: Date) => Promise<void>
  onClose: () => void
  testId?: string
}) {
  const { t } = useI18n()
  const mounted = useMounted()
  const formId = useId()
  const hintId = useId()
  const start: ZonedInput = props.initial ? zonedInput(new Date(props.initial)) : nextWholeHour()
  const [value, setValue] = useState<ZonedInput>(start)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = value.date !== start.date || value.time !== start.time
  const guardedClose = useDiscardGuard(changed, props.onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const typed = TIME.exec(value.time.trim())
    if (!DATE.test(value.date) || !typed) {
      setError(t("when.required"))
      return
    }
    const at = zonedInstant({ date: value.date, time: `${(typed[1] ?? "").padStart(2, "0")}:${typed[2]}` })
    if (!at) {
      setError(t("when.missingHour"))
      return
    }
    if (at.getTime() <= Date.now()) {
      setError(t("when.past"))
      return
    }
    setBusy(true)
    try {
      await props.onSubmit(at)
      if (!mounted.current) return
      guardedClose.dismiss()
      props.onClose()
    } catch (failure) {
      if (mounted.current) setError(errorText(t, failure))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <Dialog
      title={props.title}
      size="sm"
      onClose={() => void guardedClose()}
      foot={
        <button
          type="submit"
          form={formId}
          className="ui-btn ui-btn-primary"
          disabled={busy}
          aria-busy={busy || undefined}
          data-testid={props.testId ? `${props.testId}-submit` : undefined}
        >
          {busy ? props.busyLabel : props.submitLabel}
        </button>
      }
    >
      <form
        id={formId}
        className="ui-form-stack"
        onSubmit={(event) => void submit(event)}
        noValidate
        data-testid={props.testId}
      >
        <div className="ui-when">
          <div className="ui-field">
            <label className="ui-label" htmlFor={`${formId}-date`}>
              {t("when.date")}
            </label>
            <input
              id={`${formId}-date`}
              type="date"
              className="ui-input ui-mono"
              dir="ltr"
              required
              value={value.date}
              aria-describedby={hintId}
              onChange={(event) => setValue({ ...value, date: event.target.value })}
            />
          </div>
          <div className="ui-field">
            <label className="ui-label" htmlFor={`${formId}-time`}>
              {t("when.time")}
            </label>
            {/* Text on the 24-hour clock: a native time field shows AM and PM in some browsers' languages. */}
            <input
              id={`${formId}-time`}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              maxLength={5}
              placeholder="HH:MM"
              data-field="time"
              className="ui-input ui-mono"
              dir="ltr"
              required
              value={value.time}
              aria-describedby={hintId}
              onChange={(event) => setValue({ ...value, time: event.target.value })}
            />
          </div>
        </div>
        <p id={hintId} className="ui-hint">
          {t("when.zone")}
        </p>
        {props.children}
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Dialog>
  )
}
