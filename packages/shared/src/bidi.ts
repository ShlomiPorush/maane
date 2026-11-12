// The direction of a piece of text by its first strong character, as the Unicode bidirectional algorithm decides a
// paragraph's direction (rules P2 and P3): the first letter of a right-to-left script makes it right to left, the first
// other letter left to right, and text without a letter has no direction of its own. The server writes it on each
// paragraph of a mail body it serves (requirements 4.2: direction per paragraph, never dir="auto" in mail).

/** Letters of the right-to-left scripts: Hebrew, Arabic, Syriac, Thaana, N'Ko, Samaritan, Mandaic, and their forms. */
const RTL_LETTER =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}]/u
const LETTER = /\p{L}/u

/** "rtl" or "ltr" by the first strong character, or null for text without one (digits, punctuation, space). */
export function textDirection(text: string): "rtl" | "ltr" | null {
  for (const char of text) {
    if (RTL_LETTER.test(char)) return "rtl"
    if (LETTER.test(char)) return "ltr"
  }
  return null
}
