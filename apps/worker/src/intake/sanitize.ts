import { convert } from "html-to-text"

export { ALLOWED_SCHEMES, sanitizeMailHtml } from "@maane/server/mail/html"

export function textFromHtml(sanitized: string): string {
  return convert(sanitized, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    ],
  }).trim()
}
