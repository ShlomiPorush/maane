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

/**
 * How many reference codes and subject numbers one message may name (review G12): the first ones in the text, where
 * Maane's code sits at the top of a reply, looked up in one query each.
 */
export const MAX_CANDIDATES = 20

/** The first distinct items a pattern finds in a text, in order, at most MAX_CANDIDATES; it stops reading there. */
function firstDistinct<T>(text: string, pattern: RegExp, read: (match: RegExpExecArray) => T | null): T[] {
  const found = new Set<T>()
  for (const match of text.matchAll(pattern)) {
    const value = read(match)
    if (value !== null) found.add(value)
    if (found.size >= MAX_CANDIDATES) break
  }
  return [...found]
}

/** The reference codes in a text, in order, each once, at most MAX_CANDIDATES. Capital letters only, as Maane writes them. */
export function referenceCodesIn(text: string | null): string[] {
  if (!text) return []
  return firstDistinct(text, CODE_IN_TEXT, (match) => match[1] ?? null)
}

/** The ticket numbers written as `[#n]` in a subject, in order, each once, at most MAX_CANDIDATES. */
export function ticketNumbersIn(subject: string | null): number[] {
  if (!subject) return []
  return firstDistinct(subject, /\[#(\d{1,15})\]/g, (match) => {
    const n = Number(match[1])
    return Number.isSafeInteger(n) && n > 0 ? n : null
  })
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
