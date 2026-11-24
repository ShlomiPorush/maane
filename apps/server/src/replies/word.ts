import { DomUtils, ElementType, parseDocument } from "htmlparser2"

export const LONG_RUN = 50

type Node = ReturnType<typeof parseDocument>["children"][number]
type Text = Extract<Node, { data: string }>

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const escapeText = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

const LONG = new RegExp(`\\S{${LONG_RUN + 1},}`, "u")

export function cutForWord(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => {
      const chars = [...part]
      if (chars.length <= LONG_RUN || /\s/.test(part)) return escapeText(part)
      const lines: string[] = []
      for (let at = 0; at < chars.length; at += LONG_RUN)
        lines.push(escapeText(chars.slice(at, at + LONG_RUN).join("")))
      return lines.join("<br>")
    })
    .join("")
}

function texts(nodes: readonly Node[], out: Text[]): void {
  for (const node of nodes) {
    if (node.type === ElementType.Text) out.push(node as Text)
    else if ("children" in node && "attribs" in node) texts(node.children as Node[], out)
  }
}

export function wordCopies(html: string): string {
  if (!LONG.test(html)) return html
  const document = parseDocument(html)
  const found: Text[] = []
  texts(document.children, found)
  const long = found.filter((text) => LONG.test(text.data))
  if (long.length === 0) return html
  for (const text of long) {
    const copies = [
      ...parseDocument(
        `<!--[if mso]>${cutForWord(text.data)}<![endif]--><!--[if !mso]><!-->${escapeText(text.data)}<!--<![endif]-->`,
      ).children,
    ]
    for (const node of copies) DomUtils.prepend(text, node)
    DomUtils.removeElement(text)
  }
  return DomUtils.getOuterHTML(document.children, { encodeEntities: "utf8" })
}
