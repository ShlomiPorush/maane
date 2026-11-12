// A message body as its own document, served by GET /api/v1/messages/:id/body into the ticket view's sandboxed frame
// (plan 2.4, P3). The HTML is the stored, sanitized HTML after renderMailHtml; a message without HTML shows its text,
// escaped, line by line, each line with the direction of its first strong character (requirements 4.2: the server sets
// the direction per paragraph, never dir="auto"; a line is a paragraph in the Unicode bidirectional algorithm). The
// document's own direction follows the message's first strong character, so HTML written without `dir` (common in
// Hebrew mail) still reads right to left, and in HTML each block the sender gave no direction (a paragraph, a list
// item, a cell), and that sits in no block the sender gave one, takes the direction of its own first strong character
// (CSS unicode-bidi: plaintext), so an English paragraph reads left to right inside a Hebrew message. The route's
// policy allows only inline styles and the images built here, and no font from anywhere, so the style names fonts the
// system has.

import { textDirection } from "@maane/shared"
import sanitizeHtml from "sanitize-html"

const STYLE = [
  "html{color-scheme:light}",
  "body{margin:0;padding:14px 16px;background:#fff;color:#111814;",
  'font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Hebrew",Arial,sans-serif;',
  "overflow-wrap:anywhere}",
  "img{max-width:100%;height:auto}",
  "table{max-width:100%}",
  "pre{white-space:pre-wrap}",
  "blockquote{margin:0;padding-inline-start:12px;border-inline-start:3px solid #d6dbd8;color:#5e6863}",
  ".text>div{white-space:pre-wrap;min-height:1.55em}",
].join("")

/**
 * Blocks without a direction of their own (by dir or by style), outside every block the sender gave one: each one by its
 * own text. Alignment stays the sender's: start, the default, follows each paragraph's direction.
 */
const HTML_STYLE =
  ":where(p,div,li,dd,dt,td,th,h1,h2,h3,h4,h5,h6,blockquote,pre,center)" +
  ":not([dir],[style*=direction]):not(body [dir] *,body [style*=direction] *){unicode-bidi:plaintext}"

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

function document(dir: "rtl" | "ltr", inner: string, style = STYLE): string {
  return (
    `<!doctype html><html dir="${dir}"><head><meta charset="utf-8">` +
    `<meta name="color-scheme" content="light"><meta name="referrer" content="no-referrer">` +
    `<style>${style}</style></head><body dir="${dir}">${inner}</body></html>`
  )
}

/** The text of HTML (no tags), only to find its first strong character. */
const textOf = (html: string) => sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })

/** The rendered HTML as a document, right to left when the message's first strong character is. */
export function htmlDocument(html: string, text: string | null): string {
  const dir = textDirection(text ?? "") ?? textDirection(textOf(html)) ?? "ltr"
  return document(dir, html, STYLE + HTML_STYLE)
}

/** Plain text as a document: escaped, every line kept, each line with its own direction. */
export function textDocument(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const dir = textDirection(text) ?? "ltr"
  const inner = lines
    .map((line) => {
      const own = textDirection(line)
      // A line without a letter (a date, a rule) keeps the document's direction.
      return own === null ? `<div>${escapeHtml(line)}</div>` : `<div dir="${own}">${escapeHtml(line)}</div>`
    })
    .join("")
  return document(dir, `<div class="text">${inner}</div>`)
}
