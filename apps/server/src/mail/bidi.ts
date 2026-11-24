import bidiFactory from "bidi-js"

const bidi = bidiFactory()
const INITIATORS = new Set(["LRI", "RLI", "FSI"])

export function textDirection(text: string): "rtl" | "ltr" | null {
  let isolates = 0
  for (const char of text) {
    const type = bidi.getBidiCharTypeName(char)
    if (type === "B") isolates = 0
    else if (INITIATORS.has(type)) isolates++
    else if (type === "PDI") isolates = Math.max(0, isolates - 1)
    else if (isolates > 0) continue
    else if (type === "L") return "ltr"
    else if (type === "R" || type === "AL") return "rtl"
  }
  return null
}
