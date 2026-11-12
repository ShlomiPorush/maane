// The HTML of incoming mail. Stage one (plan 2.3, P4): sanitize-html runs before anything is stored, and only its
// output is kept. The sender's HTML exists only inside the raw MIME, which is kept only when the raw message and every
// part scanned clean. The allow list keeps the structure of ordinary mail and drops every `data:` URL and every scheme
// but https, http, mailto, tel, and cid: in href and src (the attributes that hold URLs here), and in inline styles,
// where no value may call a function other than a color (so no url(), image(), or expression()).
//
// The body route (plan 2.4, P3): the stored HTML goes through the same allow list once more, with sanitize-html's
// documented `transformTags` and `exclusiveFilter`, so an image is kept only as a `data:` URL built here from a part of
// the same message that scanned clean with an image type (its `cid:` reference), or, once the agent shows remote
// images, as an https URL. Every other image is removed with its tag, so the document never asks for anything remote
// until the agent allows it; the route's Content Security Policy blocks the rest.

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

export interface RenderOptions {
  /** The agent showed remote images for this message: https images stay. */
  remoteImages: boolean
  /**
   * The `data:` URL of an inline part of this message by its content ID (without angle brackets), or null when no part
   * with that ID scanned clean with an image type. Called only for `cid:` references.
   */
  inline: (contentId: string) => string | null
}

export interface RenderedHtml {
  html: string
  /** The https images the HTML refers to (kept only with remoteImages). */
  remoteImages: number
}

/** The scheme of a URL as sanitize-html reads one: the letters before the first colon, in lower case. */
function schemeOf(url: string): string | null {
  const match = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url)
  return match?.[1]?.toLowerCase() ?? null
}

/** A `cid:` URL's content ID (RFC 2392: percent-encoded, without angle brackets). */
function contentIdOf(url: string): string | null {
  const raw = url.trim().slice(4)
  try {
    return decodeURIComponent(raw).replace(/^<|>$/g, "").trim() || null
  } catch {
    return null
  }
}

/** Stored (sanitized) HTML made ready to serve: images resolved or removed, everything else as stored. */
export function renderMailHtml(stored: string, options: RenderOptions): RenderedHtml {
  let remoteImages = 0
  const html = sanitizeHtml(stored, {
    ...OPTIONS,
    // Only here may an image be a data: URL: the ones built below from clean parts of this message. Stage one dropped
    // every data: URL the sender wrote.
    allowedSchemesByTag: { img: options.remoteImages ? ["data", "https"] : ["data"] },
    transformTags: {
      img: (tagName, attribs) => {
        const { src, ...rest } = attribs
        const scheme = src === undefined ? null : schemeOf(src)
        let resolved: string | null = null
        if (src !== undefined && scheme === "cid") {
          const id = contentIdOf(src)
          resolved = id === null ? null : options.inline(id)
        } else if (src !== undefined && scheme === "https") {
          remoteImages++
          resolved = options.remoteImages ? src : null
        }
        return { tagName, attribs: resolved === null ? rest : { ...rest, src: resolved } }
      },
    },
    // An image left without a source (a remote one not shown yet, an unknown or blocked part) goes with its tag.
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  })
  return { html, remoteImages }
}
