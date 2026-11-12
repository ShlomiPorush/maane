// The floating save bar (v3 SV-1): shown only while something differs from what was loaded, with
// the number of changes, Discard and Save changes. It is part of the page, not a layer.

import { useI18n } from "../i18n/i18n.tsx"

export function SaveBar({
  count,
  busy,
  onSave,
  onDiscard,
}: {
  count: number
  busy: boolean
  onSave: () => void
  onDiscard: () => void
}) {
  const { t, tc } = useI18n()
  if (count === 0) return null
  return (
    <section className="ui-savebar" aria-label={t("savebar.region")}>
      <span className="ui-savebar-count" aria-live="polite">
        {tc("savebar.count", count)}
      </span>
      <button type="button" className="ui-btn ui-savebar-discard" disabled={busy} onClick={onDiscard}>
        {t("savebar.discard")}
      </button>
      <button type="button" className="ui-btn ui-savebar-save" disabled={busy} onClick={onSave}>
        {busy ? t("savebar.saving") : t("savebar.save")}
      </button>
    </section>
  )
}
