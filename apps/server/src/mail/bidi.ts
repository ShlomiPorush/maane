// The direction of a piece of text as the Unicode Bidirectional Algorithm (UAX #9) decides a paragraph's direction,
// rules P2 and P3: the first character of Bidi_Class L makes it left to right, the first of class R or AL right to left,
// characters between an isolate initiator (LRI, RLI, FSI) and its matching PDI are skipped, and text without such a
// character has no direction of its own. The Bidi_Class of each character comes from bidi-js (its documented
// getBidiCharTypeName), never from a table of Maane's. So a right-to-left mark (class R) first makes the text right to
// left, and Arabic-Indic digits (class AN, weak) do not. The server writes the result on each line of a text body and on
// the body document (requirements 4.2: the server sets the direction, never dir="auto" in mail).

import bidiFactory from "bidi-js"

const bidi = bidiFactory()
const INITIATORS = new Set(["LRI", "RLI", "FSI"])

/** "rtl" or "ltr" by the first strong character outside isolates, or null for text without one. */
export function textDirection(text: string): "rtl" | "ltr" | null {
  let isolates = 0
  for (const char of text) {
    const type = bidi.getBidiCharTypeName(char)
    // A paragraph separator ends every isolate (BD9): the next paragraph starts outside them.
    if (type === "B") isolates = 0
    else if (INITIATORS.has(type)) isolates++
    else if (type === "PDI") isolates = Math.max(0, isolates - 1)
    else if (isolates > 0) continue
    else if (type === "L") return "ltr"
    else if (type === "R" || type === "AL") return "rtl"
  }
  return null
}
