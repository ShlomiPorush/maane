import { randomInt } from "node:crypto"
import { REFERENCE_ALPHABET } from "@maane/shared"

export function newReferenceCode(): string {
  let code = ""
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-"
    code += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]
  }
  return code
}

const CODE_CHAR = `[${REFERENCE_ALPHABET}]`
const CODE_IN_TEXT = new RegExp(`(?<![A-Za-z0-9-])(${CODE_CHAR}{4}-${CODE_CHAR}{4})(?![A-Za-z0-9-])`, "g")

export const MAX_CANDIDATES = 20

function firstDistinct<T>(text: string, pattern: RegExp, read: (match: RegExpExecArray) => T | null): T[] {
  const found = new Set<T>()
  for (const match of text.matchAll(pattern)) {
    const value = read(match)
    if (value !== null) found.add(value)
    if (found.size >= MAX_CANDIDATES) break
  }
  return [...found]
}

export function referenceCodesIn(text: string | null): string[] {
  if (!text) return []
  return firstDistinct(text, CODE_IN_TEXT, (match) => match[1] ?? null)
}

export function ticketNumbersIn(subject: string | null): number[] {
  if (!subject) return []
  return firstDistinct(subject, /\[#(\d{1,15})\]/g, (match) => {
    const n = Number(match[1])
    return Number.isSafeInteger(n) && n > 0 ? n : null
  })
}

export const MAX_REFERENCED = 50

export function referencedIds(inReplyTo: readonly string[], references: readonly string[]): string[] {
  return [...new Set([...inReplyTo, ...[...references].reverse()])].slice(0, MAX_REFERENCED)
}
