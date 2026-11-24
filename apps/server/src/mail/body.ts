import { textDirection } from "./bidi.ts"
import type { Direction } from "./direction.ts"

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

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

function document(dir: Direction, inner: string): string {
  return (
    `<!doctype html><html dir="${dir}"><head><meta charset="utf-8">` +
    `<meta name="color-scheme" content="light"><meta name="referrer" content="no-referrer">` +
    `<style>${STYLE}</style></head><body dir="${dir}">${inner}</body></html>`
  )
}

export function htmlDocument(html: string, dir: Direction): string {
  return document(dir, html)
}

export function textDocument(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const dir = textDirection(text) ?? "ltr"
  const inner = lines
    .map((line) => {
      const own = textDirection(line)
      return `<div dir="${own ?? dir}">${escapeHtml(line)}</div>`
    })
    .join("")
  return document(dir, `<div class="text">${inner}</div>`)
}
