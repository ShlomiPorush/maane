import { wellFormedText } from "../text.ts"

/**
 * A string a click records: well formed, without control characters, trimmed, and at most `max` characters (cut
 * between code points); null when nothing is left.
 */
export function bounded(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null
  const clean = [...wellFormedText(text).value]
    .filter((char) => {
      const point = char.codePointAt(0) ?? 0
      return point >= 0x20 && !(point >= 0x7f && point <= 0x9f)
    })
    .join("")
    .trim()
  const cut = [...clean].slice(0, max).join("").trim()
  return cut === "" ? null : cut
}
