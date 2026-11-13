// The direction of each paragraph, set by the server (requirements 4.2: never dir="auto" in what is sent, which
// Outlook supports poorly). A render pass over stored, sanitized HTML; what is stored never changes. Each block the
// sender gave no direction of its own (by `dir` or by a `direction` style) gets `dir` from its first strong character
// (bidi.ts, UAX #9 P2 and P3), skipping what descendants with a direction of their own hold (HTML isolates them); a
// block without one, such as an image alone, takes the direction around it, the message's at the top. Inside a block
// the sender gave a direction the sender's direction stays, as before (plan 2.4). A `dir="auto"` anywhere, the 3.1
// editor's own included, is replaced by the direction of its own text. The HTML is read and written with htmlparser2
// (its documented parseDocument, ElementType, and DomUtils); its callers pass the result through sanitize-html afterwards.

import { DomUtils, ElementType, parseDocument } from "htmlparser2"
import { textDirection } from "./bidi.ts"

export type Direction = "rtl" | "ltr"

type Node = ReturnType<typeof parseDocument>["children"][number]
type Element = Extract<Node, { attribs: Record<string, string> }>
type Text = Extract<Node, { data: string }>

const isElement = (node: Node): node is Element => "attribs" in node
const isText = (node: Node): node is Text => node.type === ElementType.Text

/** The block elements that take a direction of their own: the paragraphs of mail. */
const BLOCKS = new Set([
  "p",
  "div",
  "li",
  "ul",
  "ol",
  "dd",
  "dt",
  "dl",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "center",
])

const STYLE_DIRECTION = /(?:^|;)\s*direction\s*:\s*(rtl|ltr)\b/i

/** The direction an element states itself: its `dir` (ltr or rtl), else its `direction` style; null otherwise. */
function stated(attribs: Record<string, string>): Direction | null {
  const dir = attribs.dir?.trim().toLowerCase()
  if (dir === "rtl" || dir === "ltr") return dir
  const style = STYLE_DIRECTION.exec(attribs.style ?? "")
  return style ? (style[1]?.toLowerCase() as Direction) : null
}

/** The text of a node for its first strong character: descendants with a direction of their own are isolates. */
function ownText(nodes: readonly Node[], out: string[]): void {
  for (const node of nodes) {
    if (isText(node)) out.push(node.data)
    else if (isElement(node)) {
      if (node.name === "bdi" || node.attribs.dir !== undefined || stated(node.attribs) !== null) continue
      if (node.name === "br") out.push("\n")
      else ownText(node.children, out)
    }
  }
}

function firstStrong(nodes: readonly Node[]): Direction | null {
  const out: string[] = []
  ownText(nodes, out)
  // A line break inside a block does not end it for this purpose: the block takes one direction.
  return textDirection(out.join("").replace(/\s+/g, " "))
}

function walk(nodes: readonly Node[], around: Direction, senderSet: boolean): void {
  for (const node of nodes) {
    if (!isElement(node)) continue
    const own = stated(node.attribs)
    let dir = around
    let inSender = senderSet
    if (own !== null) {
      dir = own
      inSender = true
      // A direction the sender stated by style, beside dir="auto" (or any other value), becomes the attribute: what is
      // sent never holds dir="auto".
      if (node.attribs.dir !== undefined) node.attribs.dir = own
    } else if (node.attribs.dir !== undefined || (!senderSet && BLOCKS.has(node.name))) {
      // dir="auto" (or a value that is not a direction) anywhere, and every block outside the sender's own.
      dir = firstStrong(node.children) ?? around
      node.attribs.dir = dir
    }
    walk(node.children, dir, inSender)
  }
}

/** The direction of a whole message: its text's first strong character, else its HTML's, else the fallback. */
export function messageDirection(text: string | null, html: string | null, fallback: Direction): Direction {
  if (text) {
    const found = textDirection(text)
    if (found) return found
  }
  if (html) {
    const found = textDirection(DomUtils.textContent(parseDocument(html)))
    if (found) return found
  }
  return fallback
}

/** HTML with `dir` on each block, as above. `around` is the message's direction. */
export function directBlocks(html: string, around: Direction): string {
  const document = parseDocument(html)
  walk(document.children, around, false)
  return DomUtils.getOuterHTML(document.children, { encodeEntities: "utf8" })
}
