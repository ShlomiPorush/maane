// Long strings without spaces in classic Outlook for Windows (the owner's `html-email` skill, "Long values without
// spaces"): Word ignores word-break and overflow-wrap, so a long URL or code widens the email and gets a scrollbar.
// As the skill prescribes, Word gets its own copy of a text that holds such a run, inside <!--[if mso]>, with only the
// runs longer than the column holds cut into lines joined with <br>; every other client gets the unchanged text inside
// <!--[if !mso]><!-->. Only those texts are doubled, not the email. The text is cut before it is escaped, so no entity
// is split, and between code points. Read and written with htmlparser2's documented parseDocument and DomUtils.

import { DomUtils, ElementType, parseDocument } from "htmlparser2"

/** The longest run without spaces a line of the column holds, in characters (15px Arial, 600px, wide letters). */
export const LONG_RUN = 50

type Node = ReturnType<typeof parseDocument>["children"][number]
type Text = Extract<Node, { data: string }>

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const escapeText = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

const LONG = new RegExp(`\\S{${LONG_RUN + 1},}`, "u")

/** Word's copy of a text: each run longer than LONG_RUN cut every LONG_RUN characters, the pieces joined with <br>. */
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

/** HTML whose texts with a run longer than LONG_RUN carry a copy for Word, cut into lines, as above. */
export function wordCopies(html: string): string {
  if (!LONG.test(html)) return html
  const document = parseDocument(html)
  const found: Text[] = []
  texts(document.children, found)
  const long = found.filter((text) => LONG.test(text.data))
  // A long run only in an attribute (a style, a link): the HTML stays as it was.
  if (long.length === 0) return html
  for (const text of long) {
    const copies = [
      ...parseDocument(
        `<!--[if mso]>${cutForWord(text.data)}<![endif]--><!--[if !mso]><!-->${escapeText(text.data)}<!--<![endif]-->`,
      ).children,
    ]
    // Copied first: moving a node out of the snippet changes the snippet's own list.
    for (const node of copies) DomUtils.prepend(text, node)
    DomUtils.removeElement(text)
  }
  return DomUtils.getOuterHTML(document.children, { encodeEntities: "utf8" })
}
