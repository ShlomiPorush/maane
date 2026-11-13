/**
 * What a client other than Word shows: the HTML without its comments (Word's copy lives in one), read left to right,
 * a comment ending at the first `-->` after its `<!--`. A loop, not a regular expression, so no input can make it slow.
 */
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
