// Automated mail (plan 2.3, P11; requirements 2.2), per RFC 3834 (automatic responses), RFC 3464 (delivery status
// notifications), RFC 8098 (disposition notifications), RFC 2919 and RFC 2369 (mailing lists). Automated mail never
// opens, joins, or reopens a ticket. `X-Auto-Response-Suppress` asks others not to answer; it says nothing about the
// message that carries it, so it is never a sign. A From of MAILER-DAEMON or postmaster without any sign opens a ticket
// flagged "possibly automated" for a person to look at.

// The signs of automated mail, as the intake record names them, live in @maane/shared (intake.ts), where the intake
// log finds their words.
import type { AutomatedSign } from "@maane/shared"

export { AUTOMATED_SIGNS, type AutomatedSign } from "@maane/shared"

export interface ClassifyInput {
  /** Every header line as received (`Key: value`, possibly folded). */
  headers: { key: string; line: string }[]
  /** The top-level content type as mailparser parsed it, stored bounded (content.ts). */
  contentType: { value: string; reportType: string | null }
  /** The From address, lower case. */
  from: string | null
}

export interface Classification {
  automated: boolean
  signs: AutomatedSign[]
  /** From MAILER-DAEMON or postmaster with no sign: a ticket, flagged for review. */
  possiblyAutomated: boolean
}

/** A header's values: the text after the first colon of each line with that name, unfolded and trimmed. */
function values(headers: ClassifyInput["headers"], name: string): string[] {
  return headers
    .filter((header) => header.key.toLowerCase() === name)
    .map((header) => {
      const colon = header.line.indexOf(":")
      return (colon >= 0 ? header.line.slice(colon + 1) : "").replace(/\r?\n[ \t]+/g, " ").trim()
    })
}

const has = (headers: ClassifyInput["headers"], name: string) => values(headers, name).length > 0

export function classify(input: ClassifyInput): Classification {
  const signs: AutomatedSign[] = []
  // RFC 3834 5.1: any value but "no" (its keyword is case-insensitive; parameters follow a semicolon).
  const autoSubmitted = values(input.headers, "auto-submitted")
  if (autoSubmitted.some((value) => (value.split(";")[0] ?? "").trim().toLowerCase() !== "no"))
    signs.push("auto_submitted")
  if (input.contentType.value === "multipart/report") {
    const kind = input.contentType.reportType
    if (kind === "delivery-status") signs.push("delivery_report")
    else if (kind === "disposition-notification") signs.push("disposition_report")
  }
  if (values(input.headers, "precedence").some((value) => /^(bulk|list|junk)$/i.test(value))) signs.push("precedence")
  if (has(input.headers, "list-id") || has(input.headers, "list-unsubscribe")) signs.push("list")
  if (has(input.headers, "x-autoreply") || has(input.headers, "x-autorespond")) signs.push("autoreply_header")
  const local = (input.from ?? "").split("@")[0]?.toLowerCase() ?? ""
  const automated = signs.length > 0
  return { automated, signs, possiblyAutomated: !automated && (local === "mailer-daemon" || local === "postmaster") }
}
