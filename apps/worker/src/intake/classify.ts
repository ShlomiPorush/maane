import type { AutomatedSign } from "@maane/shared"

export { AUTOMATED_SIGNS, type AutomatedSign } from "@maane/shared"

export interface ClassifyInput {
  headers: { key: string; line: string }[]
  contentType: { value: string; reportType: string | null }
  from: string | null
}

export interface Classification {
  automated: boolean
  signs: AutomatedSign[]
  possiblyAutomated: boolean
}

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
