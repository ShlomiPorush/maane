import { matchSupportAddress } from "@maane/shared"
import type { Db } from "../db/client.ts"
import { supportAddress } from "../db/schema.ts"

export type Rule = { kind: "exact" | "pattern"; value: string; isDefault: boolean; organizationId: string }

export function belongsTo(address: string, rules: readonly Rule[], organizationId: string): boolean {
  const match = matchSupportAddress(address, rules)
  return match !== null && match.rule.organizationId === organizationId
}

export function fromAddresses(
  rules: readonly Rule[],
  organizationId: string,
  ticketAddress: string,
): { from: string[]; defaultFrom: string | null } {
  const own = rules
    .filter((rule) => rule.kind === "exact" && rule.organizationId === organizationId)
    .map((rule) => rule.value)
    .sort()
  const kept = belongsTo(ticketAddress, rules, organizationId) ? ticketAddress : null
  const from = kept && !own.includes(kept) ? [kept, ...own] : own
  return { from, defaultFrom: kept ?? from[0] ?? null }
}

export async function supportRules(db: Pick<Db, "select">): Promise<Rule[]> {
  return (await db
    .select({
      kind: supportAddress.kind,
      value: supportAddress.value,
      isDefault: supportAddress.isDefault,
      organizationId: supportAddress.organizationId,
    })
    .from(supportAddress)) as Rule[]
}
