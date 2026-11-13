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

/** The schemes a link in a served body may open (in a new tab, isolated); tel: and cid: links lose their address. */
const LINK_SCHEMES = new Set(["https", "http", "mailto"])

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
    allowedSchemesByTag: { img: options.remoteImages ? ["data", "https"] : ["data"], a: [...LINK_SCHEMES] },
    allowedAttributes: { ...OPTIONS.allowedAttributes, a: ["href", "name", "target", "rel"] },
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
      // A link opens in a new tab, cut off from Maane (owner's decision, 2026-11-13): only an https, http, or mailto
      // link keeps its address, with target="_blank" and rel="noopener noreferrer"; any other link loses it.
      a: (tagName, attribs) => {
        const { href, target: _target, rel: _rel, ...rest } = attribs
        const scheme = href === undefined ? null : schemeOf(href)
        if (href === undefined || scheme === null || !LINK_SCHEMES.has(scheme)) return { tagName, attribs: rest }
        return { tagName, attribs: { ...rest, href, target: "_blank", rel: "noopener noreferrer" } }
      },
    },
    // An image left without a source (a remote one not shown yet, an unknown or blocked part) goes with its tag.
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  })
  return { html, remoteImages }
}

/** An image of the email: its new content ID and the size it is shown at, or only its name. */
export type EmailImage = { cid: string; width: number; height: number } | { name: string }

/**
 * Stored (sanitized) HTML made ready for a customer's email (plan 3.2), through the same allow list: an image is kept
 * only as an embedded part (`cid:`) that the email carries, with its size as attributes and as a style no wider than
 * the column (Outlook for Windows ignores max-width), or shows only its name; every other image (remote ones too) is
 * removed with its tag. A link keeps an https, http, or mailto address and its underline, inline with !important so
 * the rule that gives the links a mail client adds the text's look leaves it alone (`html-email`).
 */
export function renderEmailHtml(stored: string, image: (contentId: string) => EmailImage | null): string {
  return sanitizeHtml(stored, {
    ...OPTIONS,
    allowedSchemesByTag: { img: ["cid"], a: [...LINK_SCHEMES] },
    transformTags: {
      img: (tagName, attribs) => {
        const { src, width: _width, height: _height, style: _style, ...rest } = attribs
        const id = src !== undefined && schemeOf(src) === "cid" ? contentIdOf(src) : null
        const found = id === null ? null : image(id)
        // An image the email does not carry becomes a tag the allow list does not know, so it goes (the documented
        // discard of disallowed tags); an image in only its name becomes that text.
        if (found === null) return { tagName: "maane-dropped", attribs: {} }
        if ("name" in found) return { tagName: "span", attribs: {}, text: `[${found.name}]` }
        return {
          tagName,
          attribs: {
            ...rest,
            src: `cid:${found.cid}`,
            width: String(found.width),
            height: String(found.height),
            style: `width:${found.width}px;max-width:100%;height:auto;border:0`,
          },
        }
      },
      a: (tagName, attribs) => {
        const { href, ...rest } = attribs
        const scheme = href === undefined ? null : schemeOf(href)
        if (href === undefined || scheme === null || !LINK_SCHEMES.has(scheme)) return { tagName, attribs: rest }
        return { tagName, attribs: { ...rest, href, style: "text-decoration:underline !important" } }
      },
    },
  })
}
