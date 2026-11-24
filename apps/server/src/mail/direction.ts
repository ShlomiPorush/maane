import { DomUtils, ElementType, parseDocument } from "htmlparser2"
import { textDirection } from "./bidi.ts"

export type Direction = "rtl" | "ltr"

type Node = ReturnType<typeof parseDocument>["children"][number]
type Element = Extract<Node, { attribs: Record<string, string> }>
type Text = Extract<Node, { data: string }>

const isElement = (node: Node): node is Element => "attribs" in node
const isText = (node: Node): node is Text => node.type === ElementType.Text

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

function stated(attribs: Record<string, string>): Direction | null {
  const dir = attribs.dir?.trim().toLowerCase()
  if (dir === "rtl" || dir === "ltr") return dir
  const style = STYLE_DIRECTION.exec(attribs.style ?? "")
  return style ? (style[1]?.toLowerCase() as Direction) : null
}

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
  // With its line breaks, a block whose isolate spans one would end the isolate early and can turn right to left.
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
      if (node.attribs.dir !== undefined) node.attribs.dir = own
    } else if (node.attribs.dir !== undefined || (!senderSet && BLOCKS.has(node.name))) {
      dir = firstStrong(node.children) ?? around
      node.attribs.dir = dir
    }
    walk(node.children, dir, inSender)
  }
}

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

export function directBlocks(html: string, around: Direction): string {
  const document = parseDocument(html)
  walk(document.children, around, false)
  return DomUtils.getOuterHTML(document.children, { encodeEntities: "utf8" })
}
