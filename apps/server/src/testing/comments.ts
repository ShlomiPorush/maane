export function withoutComments(html: string): string {
  let out = ""
  let at = 0
  for (;;) {
    const open = html.indexOf("<!--", at)
    if (open < 0) return out + html.slice(at)
    out += html.slice(at, open)
    const close = html.indexOf("-->", open + 4)
    if (close < 0) return out
    at = close + 3
  }
}
