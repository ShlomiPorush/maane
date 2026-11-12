// Threading hints and the ticket reference code (plan 2.3; requirements 2.2). A reply matches by the first layer
// found: the In-Reply-To and References headers, then the ticket's reference code in the body, then `[#n]` in the
// subject. Every layer is only a hint: the sender must be a participant of the ticket it points at.

import { randomInt } from "node:crypto"
import { REFERENCE_ALPHABET } from "@maane/shared"

/** A new reference code, `XXXX-XXXX`, from the CSPRNG over the alphabet without look-alike characters. */
export function newReferenceCode(): string {
  let code = ""
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-"
    code += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]
  }
  return code
}

const CODE_CHAR = `[${REFERENCE_ALPHABET}]`
/** A code standing alone: not inside a longer run of letters, digits, or hyphens. */
const CODE_IN_TEXT = new RegExp(`(?<![A-Za-z0-9-])(${CODE_CHAR}{4}-${CODE_CHAR}{4})(?![A-Za-z0-9-])`, "g")

/** The reference codes in a text, in order, each once. Capital letters only, as Maane writes them. */
export function referenceCodesIn(text: string | null): string[] {
  if (!text) return []
  return [...new Set([...text.matchAll(CODE_IN_TEXT)].map((match) => match[1] ?? ""))].filter(Boolean)
}

/** The ticket numbers written as `[#n]` in a subject, in order, each once. */
export function ticketNumbersIn(subject: string | null): number[] {
  if (!subject) return []
  const numbers = [...subject.matchAll(/\[#(\d{1,15})\]/g)].map((match) => Number(match[1]))
  return [...new Set(numbers.filter((n) => Number.isSafeInteger(n) && n > 0))]
}

/** The most Message-IDs one message may refer to (review G2): every query over them stays small. */
export const MAX_REFERENCED = 50

/**
 * The Message-IDs a message refers to, the most direct first: In-Reply-To, then References from the last (the parent)
 * to the first (the root), each once, at most MAX_REFERENCED.
 */
export function referencedIds(inReplyTo: readonly string[], references: readonly string[]): string[] {
  return [...new Set([...inReplyTo, ...[...references].reverse()])].slice(0, MAX_REFERENCED)
}
