// Support addresses: the exact addresses and patterns an organization answers on, and the one function that decides
// which of them an incoming address belongs to. The admin's "Which organization gets this address?" check and the
// intake use this same function, so they can never disagree.
//
// Syntax. An exact address is a plain address (`support@example.com`). A pattern is a whole address with at least one
// `*` in its local part (`*@example.com`, `support-*@example.com`); each `*` matches one or more characters that are
// not `@`, and the domain is literal. Both are stored in lower case and compared without regard to case. Anything
// else is refused at save with a field error.
//
// Order. An exact address wins; among patterns, the one with more literal characters wins; a tie goes to the pattern
// text that sorts first by its bytes. So the result never depends on the order the rows were read in.

/** The longest organization name, in characters; customers see it in the sender name. */
export const ORGANIZATION_NAME_MAX = 80

export const ADDRESS_KINDS = ["exact", "pattern"] as const
export type AddressKind = (typeof ADDRESS_KINDS)[number]

/** The longest address SMTP allows (RFC 5321: 64 for the local part, 254 in all). */
export const ADDRESS_MAX = 254
const LOCAL_MAX = 64

/** Why a value was refused: a stable code the API returns and the UI explains. */
export type AddressRefusal = "address_invalid" | "pattern_invalid"

export type ParsedAddress = { ok: true; value: string } | { ok: false; code: AddressRefusal }

// Letters, digits, and the special characters RFC 5322 allows in an unquoted local part. Quoted local parts and
// non-ASCII addresses are not support addresses Maane needs.
const LOCAL = /^[a-z0-9!#$%&'+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'+/=?^_`{|}~-]+)*$/
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function validDomain(domain: string): boolean {
  const labels = domain.split(".")
  return labels.length >= 2 && labels.every((label) => LABEL.test(label))
}

/** Splits an address at its one `@`, or returns null. */
function split(value: string): { local: string; domain: string } | null {
  const at = value.indexOf("@")
  if (at <= 0 || at !== value.lastIndexOf("@")) return null
  return { local: value.slice(0, at), domain: value.slice(at + 1) }
}

/** An exact address in its stored form (trimmed, lower case), or the refusal. */
export function parseExactAddress(text: string): ParsedAddress {
  const value = text.trim().toLowerCase()
  const parts = value.length <= ADDRESS_MAX ? split(value) : null
  if (!parts || parts.local.length > LOCAL_MAX || !LOCAL.test(parts.local) || !validDomain(parts.domain))
    return { ok: false, code: "address_invalid" }
  return { ok: true, value }
}

/** A pattern in its stored form (trimmed, lower case), or the refusal. */
export function parsePattern(text: string): ParsedAddress {
  const value = text.trim().toLowerCase()
  const parts = value.length <= ADDRESS_MAX ? split(value) : null
  const refused = { ok: false, code: "pattern_invalid" } as const
  if (!parts || parts.local.length > LOCAL_MAX || !validDomain(parts.domain)) return refused
  // At least one `*`, never two in a row (they would mean the same as one), and only in the local part.
  if (!parts.local.includes("*") || parts.local.includes("**")) return refused
  // Each `*` stands for one or more ordinary characters, so the local part must be valid with any of them in its place.
  if (!LOCAL.test(parts.local.replaceAll("*", "x"))) return refused
  return { ok: true, value }
}

export function parseSupportAddress(kind: AddressKind, text: string): ParsedAddress {
  return kind === "exact" ? parseExactAddress(text) : parsePattern(text)
}

/** How many characters of a pattern are not `*`: the more, the more specific. */
export function literalCount(pattern: string): number {
  return pattern.length - (pattern.match(/\*/g)?.length ?? 0)
}

/**
 * Whether a stored pattern matches an address in its stored form: each `*` stands for one or more characters that are
 * not `@`, every other character for itself. Dynamic programming over the two texts, so the work is at most
 * pattern length times address length (about 65,000 steps for the longest), whatever the pattern. A regular
 * expression built from the pattern would backtrack exponentially on patterns such as `a*a*a*...b@example.com`, and
 * the server runs this on every incoming address.
 */
export function patternMatches(pattern: string, address: string): boolean {
  const width = address.length
  // previous[j]: the pattern so far matches the first j characters of the address.
  let previous: boolean[] = Array.from({ length: width + 1 }, (_, j) => j === 0)
  // Both texts are read by UTF-16 unit, the same way on each side (stored values are ASCII anyway).
  for (let i = 0; i < pattern.length; i++) {
    const token = pattern[i]
    const current: boolean[] = new Array(width + 1).fill(false)
    for (let j = 1; j <= width; j++) {
      const char = address[j - 1]
      current[j] =
        token === "*"
          ? // One more character for this star: it starts here (after the earlier tokens) or continues.
            char !== "@" && ((previous[j - 1] ?? false) || (current[j - 1] ?? false))
          : char === token && (previous[j - 1] ?? false)
    }
    previous = current
  }
  return previous[width] ?? false
}

const encoder = new TextEncoder()

/** Byte order of two texts, so a tie between patterns has one answer whatever the runtime's string collation. */
export function compareBytes(a: string, b: string): number {
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

/** The fields of a stored support address that matching reads. */
export interface AddressRule {
  kind: AddressKind
  value: string
  isDefault: boolean
}

/**
 * The rule one address belongs to, without the default: the exact address when one is stored, else the most specific
 * matching pattern. `address` is compared in its stored form; anything that is not a valid address matches nothing.
 */
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

/**
 * The support address a message belongs to: the first of `addresses` (the intake passes `To`, then `Cc`) that matches
 * a stored address or pattern; with no match, the default address; with no default either, none.
 */
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
