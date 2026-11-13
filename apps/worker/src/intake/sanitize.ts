// The HTML of incoming mail (plan 2.3, P4): sanitize-html runs before anything is stored, and only its output is kept.
// The allow list lives in the server (apps/server/src/mail/html.ts), which applies it once more when it serves a body
// (plan 2.4). When a message has no text part, its stored text is made from the sanitized HTML with html-to-text (the
// library mailparser itself uses), with images skipped.

import { convert } from "html-to-text"

export { ALLOWED_SCHEMES, sanitizeMailHtml } from "@maane/server/mail/html"

/** Plain text from sanitized HTML, for a message without a text part. Images are skipped; links keep their URL. */
export function textFromHtml(sanitized: string): string {
  return convert(sanitized, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    ],
  }).trim()
}
