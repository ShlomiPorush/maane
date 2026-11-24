const NUL = String.fromCharCode(0)
const REPLACEMENT = String.fromCodePoint(0xfffd)

export function wellFormedText(text: string): { value: string; changed: boolean } {
  const value = text.replaceAll(NUL, REPLACEMENT).toWellFormed()
  return { value, changed: value !== text }
}

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
