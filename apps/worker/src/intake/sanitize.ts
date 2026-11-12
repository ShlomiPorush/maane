// The HTML of incoming mail (plan 2.3, P4): sanitize-html runs before anything is stored, and only its output is kept.
// The sender's HTML exists only inside the raw MIME, which is kept only when the raw message and every part scanned
// clean. The allow list keeps the structure of ordinary mail and drops every `data:` URL and every scheme but https,
// http, mailto, tel, and cid: in href and src (the attributes that hold URLs here), and in inline styles, where no
// value may call a function other than a color (so no url(), image(), or expression()). When a message has no text
// part, its stored text is made from the sanitized HTML with html-to-text (the library mailparser itself uses), with
// images skipped.

import { convert } from "html-to-text"
import sanitizeHtml from "sanitize-html"

/** The schemes a link or an image may use. Everything else, `data:` first, is dropped with its attribute. */
export const ALLOWED_SCHEMES = ["https", "http", "mailto", "tel", "cid"] as const

/** A style value made of words, numbers, units, colors, quotes, and only the color functions. */
const STYLE_VALUE = /^(?:[-\w\s#%.,'"!/]|(?:rgba?|hsla?)\([\d\s.,%/]+\))*$/i

const STYLED = [
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "text-align",
  "text-decoration",
  "text-indent",
  "line-height",
  "letter-spacing",
  "direction",
  "unicode-bidi",
  "vertical-align",
  "white-space",
  "width",
  "max-width",
  "min-width",
  "height",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-style",
  "border-width",
  "border-collapse",
  "border-spacing",
  "border-radius",
  "display",
  "list-style-type",
] as const

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    "img",
    "font",
    "center",
    "span",
    "div",
    "u",
    "s",
    "strike",
    "big",
    "small",
    "sub",
    "sup",
    "hr",
    "br",
  ],
  disallowedTagsMode: "discard",
  allowedAttributes: {
    "*": ["dir", "lang", "align", "valign", "style", "title", "width", "height"],
    a: ["href", "name"],
    img: ["src", "alt"],
    font: ["color", "size", "face"],
    table: ["border", "cellpadding", "cellspacing", "bgcolor"],
    td: ["colspan", "rowspan", "bgcolor", "nowrap"],
    th: ["colspan", "rowspan", "bgcolor", "nowrap", "scope"],
    tr: ["bgcolor"],
    col: ["span"],
    colgroup: ["span"],
    ol: ["start", "type"],
    li: ["value"],
  },
  allowedSchemes: [...ALLOWED_SCHEMES],
  allowedSchemesByTag: {},
  allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
  allowProtocolRelative: false,
  allowedStyles: { "*": Object.fromEntries(STYLED.map((property) => [property, [STYLE_VALUE]])) },
  parseStyleAttributes: true,
  enforceHtmlBoundary: true,
}

/** The sender's HTML through the allow list: the only HTML Maane stores. */
export function sanitizeMailHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS)
}

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
