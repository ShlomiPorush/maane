export const ORGANIZATION_NAME_MAX = 80

export const ADDRESS_KINDS = ["exact", "pattern"] as const
export type AddressKind = (typeof ADDRESS_KINDS)[number]

export const ADDRESS_MAX = 254
const LOCAL_MAX = 64

export type AddressRefusal = "address_invalid" | "pattern_invalid"

export type ParsedAddress = { ok: true; value: string } | { ok: false; code: AddressRefusal }

const LOCAL = /^[a-z0-9!#$%&'+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'+/=?^_`{|}~-]+)*$/
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function validDomain(domain: string): boolean {
  const labels = domain.split(".")
  return labels.length >= 2 && labels.every((label) => LABEL.test(label))
}

function split(value: string): { local: string; domain: string } | null {
  const at = value.indexOf("@")
  if (at <= 0 || at !== value.lastIndexOf("@")) return null
  return { local: value.slice(0, at), domain: value.slice(at + 1) }
}

export function parseExactAddress(text: string): ParsedAddress {
  const value = text.trim().toLowerCase()
  const parts = value.length <= ADDRESS_MAX ? split(value) : null
  if (!parts || parts.local.length > LOCAL_MAX || !LOCAL.test(parts.local) || !validDomain(parts.domain))
    return { ok: false, code: "address_invalid" }
  return { ok: true, value }
}

export function parsePattern(text: string): ParsedAddress {
  const value = text.trim().toLowerCase()
  const parts = value.length <= ADDRESS_MAX ? split(value) : null
  const refused = { ok: false, code: "pattern_invalid" } as const
  if (!parts || parts.local.length > LOCAL_MAX || !validDomain(parts.domain)) return refused
  if (!parts.local.includes("*") || parts.local.includes("**")) return refused
  if (!LOCAL.test(parts.local.replaceAll("*", "x"))) return refused
  return { ok: true, value }
}

export function parseSupportAddress(kind: AddressKind, text: string): ParsedAddress {
  return kind === "exact" ? parseExactAddress(text) : parsePattern(text)
}

export function literalCount(pattern: string): number {
  return pattern.length - (pattern.match(/\*/g)?.length ?? 0)
}

export function patternMatches(pattern: string, address: string): boolean {
  const width = address.length
  let previous: boolean[] = Array.from({ length: width + 1 }, (_, j) => j === 0)
  for (let i = 0; i < pattern.length; i++) {
    const token = pattern[i]
    const current: boolean[] = new Array(width + 1).fill(false)
    for (let j = 1; j <= width; j++) {
      const char = address[j - 1]
      current[j] =
        token === "*"
          ? char !== "@" && ((previous[j - 1] ?? false) || (current[j - 1] ?? false))
          : char === token && (previous[j - 1] ?? false)
    }
    previous = current
  }
  return previous[width] ?? false
}

const encoder = new TextEncoder()

export function compareBytes(a: string, b: string): number {
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

export interface AddressRule {
  kind: AddressKind
  value: string
  isDefault: boolean
}

export function matchSupportAddress<R extends AddressRule>(
  address: string,
  rules: readonly R[],
): { via: "exact" | "pattern"; rule: R } | null {
  const parsed = parseExactAddress(address)
  if (!parsed.ok) return null
  const exact = rules.find((rule) => rule.kind === "exact" && rule.value === parsed.value)
  if (exact) return { via: "exact", rule: exact }
  const patterns = rules
    .filter((rule) => rule.kind === "pattern" && patternMatches(rule.value, parsed.value))
    .sort((a, b) => literalCount(b.value) - literalCount(a.value) || compareBytes(a.value, b.value))
  const best = patterns[0]
  return best ? { via: "pattern", rule: best } : null
}

export type Resolution<R> =
  | { via: "exact" | "pattern"; address: string; rule: R }
  | { via: "default"; rule: R }
  | { via: "none" }

export function resolveSupportAddress<R extends AddressRule>(
  addresses: readonly string[],
  rules: readonly R[],
): Resolution<R> {
  for (const address of addresses) {
    const match = matchSupportAddress(address, rules)
    if (match) return { ...match, address: address.trim().toLowerCase() }
  }
  const fallback = rules.find((rule) => rule.isDefault)
  return fallback ? { via: "default", rule: fallback } : { via: "none" }
}
