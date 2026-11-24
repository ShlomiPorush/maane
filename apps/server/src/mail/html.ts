import { DomUtils, parseDocument } from "htmlparser2"
import sanitizeHtml from "sanitize-html"

export const ALLOWED_SCHEMES = ["https", "http", "mailto", "tel", "cid"] as const

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

export function sanitizeMailHtml(html: string, image?: (src: string) => string | null): string {
  if (!image) return sanitizeHtml(html, OPTIONS)
  return sanitizeHtml(html, {
    ...OPTIONS,
    transformTags: {
      img: (tagName, attribs) => {
        const src = attribs.src === undefined ? null : image(attribs.src)
        return { tagName, attribs: src === null ? attribs : { ...attribs, src } }
      },
    },
  })
}

export interface RenderOptions {
  remoteImages: boolean
  inline: (contentId: string) => string | null
}

export interface RenderedHtml {
  html: string
  remoteImages: number
}

const LINK_SCHEMES = new Set(["https", "http", "mailto"])

function schemeOf(url: string): string | null {
  const match = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url)
  return match?.[1]?.toLowerCase() ?? null
}

function contentIdOf(url: string): string | null {
  const raw = url.trim().slice(4)
  try {
    return decodeURIComponent(raw).replace(/^<|>$/g, "").trim() || null
  } catch {
    return null
  }
}

export function renderMailHtml(stored: string, options: RenderOptions): RenderedHtml {
  let remoteImages = 0
  const html = sanitizeHtml(stored, {
    ...OPTIONS,
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
      a: (tagName, attribs) => {
        const { href, target: _target, rel: _rel, ...rest } = attribs
        const scheme = href === undefined ? null : schemeOf(href)
        if (href === undefined || scheme === null || !LINK_SCHEMES.has(scheme)) return { tagName, attribs: rest }
        return { tagName, attribs: { ...rest, href, target: "_blank", rel: "noopener noreferrer" } }
      },
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  })
  return { html, remoteImages }
}

export type EmailImage = { cid: string; width: number; height: number } | { name: string }

export function renderEmailHtml(
  stored: string,
  image: (contentId: string) => EmailImage | null,
  link?: (href: string) => string,
): string {
  return sanitizeHtml(stored, {
    ...OPTIONS,
    allowedSchemesByTag: { img: ["cid"], a: [...LINK_SCHEMES] },
    transformTags: {
      img: (tagName, attribs) => {
        const { src, width: _width, height: _height, style: _style, ...rest } = attribs
        const id = src !== undefined && schemeOf(src) === "cid" ? contentIdOf(src) : null
        const found = id === null ? null : image(id)
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
        const carried = link && (scheme === "https" || scheme === "http") ? link(href) : href
        return { tagName, attribs: { ...rest, href: carried, style: "text-decoration:underline !important" } }
      },
    },
  })
}

export function contentIdsIn(html: string): Set<string> {
  const ids = new Set<string>()
  for (const image of DomUtils.getElementsByTagName("img", parseDocument(html).children)) {
    const src = image.attribs.src
    const id = src !== undefined && schemeOf(src) === "cid" ? contentIdOf(src) : null
    if (id) ids.add(id)
  }
  return ids
}
