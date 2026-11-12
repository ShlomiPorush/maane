// Click to copy (v3 FB-12): IDs in mono copy on a click, show "Copied: value" and turn their icon
// into a check for 1.5 seconds. Inside a clickable row the click copies without opening the row.

import { Check, Copy } from "lucide-react"
import { useState } from "react"
import { useI18n } from "../i18n/i18n.tsx"
import { showToast } from "./Toast.tsx"

/** `dir="ltr"` for a value that must read left to right inside right-to-left text (an address, a pattern). */
export function Copyable({ value, dir }: { value: string; dir?: "ltr" }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={copied ? "ui-copy is-copied" : "ui-copy"}
      title={t("copy.hint")}
      onClick={async (event) => {
        event.stopPropagation()
        event.preventDefault()
        if (!navigator.clipboard) {
          showToast(t("copy.needsHttps"), "error")
          return
        }
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
          showToast(t("copy.done", { value }), "success")
        } catch {
          showToast(t("copy.failed"), "error")
        }
      }}
    >
      <bdi className="ui-mono" dir={dir}>
        {value}
      </bdi>
      {copied ? (
        <Check className="ui-copy-icon" aria-hidden="true" />
      ) : (
        <Copy className="ui-copy-icon" aria-hidden="true" />
      )}
    </button>
  )
}
