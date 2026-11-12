// Values PostgreSQL cannot store (plan 2.3, P21, P22): a `text` column refuses U+0000, and `jsonb` refuses U+0000
// and unpaired surrogates. Every decoded string headed for the database passes through wellFormed() at one place, the
// row about to be inserted, so no header, address, subject, file name, text, HTML, Graph metadata, or audit detail can
// carry one. The raw MIME, kept as bytes, is unchanged.

const NUL = String.fromCharCode(0)
const REPLACEMENT = String.fromCodePoint(0xfffd)

/** The text with U+0000 and every unpaired surrogate replaced by U+FFFD, and whether anything was replaced. */
export function wellFormedText(text: string): { value: string; changed: boolean } {
  const value = text.replaceAll(NUL, REPLACEMENT).toWellFormed()
  return { value, changed: value !== text }
}

/**
 * A copy of a value with every string in it (object keys included) well formed, and whether anything changed. Buffers,
 * dates, numbers, booleans, and null pass through unchanged.
 */
export function wellFormed<T>(value: T): { value: T; changed: boolean } {
  let changed = false
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") {
      const fixed = wellFormedText(item)
      if (fixed.changed) changed = true
      return fixed.value
    }
    if (item === null || typeof item !== "object" || item instanceof Date || item instanceof Uint8Array) return item
    if (Array.isArray(item)) return item.map(visit)
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(item)) result[visit(key) as string] = visit(entry)
    return result
  }
  const result = visit(value) as T
  return { value: result, changed }
}
