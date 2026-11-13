// Which organization a From address belongs to, by the shared matcher over every support address (plan 3.1). The
// server checks it when a reply is written and the worker again when it is sent; it lives apart from the reply service
// so the worker does not load what only the server needs to build a message (the image code and its native module).

import { matchSupportAddress } from "@maane/shared"
import type { Db } from "../db/client.ts"
import { supportAddress } from "../db/schema.ts"

export type Rule = { kind: "exact" | "pattern"; value: string; isDefault: boolean; organizationId: string }

/** Whether an address belongs to an organization by the shared matcher (exact first, then patterns). */
export function belongsTo(address: string, rules: readonly Rule[], organizationId: string): boolean {
  const match = matchSupportAddress(address, rules)
  return match !== null && match.rule.organizationId === organizationId
}

/** Every support address, as the shared matcher reads them. */
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
