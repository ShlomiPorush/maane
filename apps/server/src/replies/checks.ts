import type { SendProblem } from "@maane/shared"
import { eq } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { authUser } from "../db/schema.ts"
import { inScope, visibleOrganizations } from "../organizations/scope.ts"
import { belongsTo, supportRules } from "./rules.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export async function sendProblem(
  tx: Pick<Tx, "select">,
  row: { from: string; organizationId: string; authorUserId: string | null; automated?: boolean },
): Promise<Extract<SendProblem, "from_not_allowed" | "author_not_allowed"> | null> {
  if (!belongsTo(row.from, await supportRules(tx), row.organizationId)) return "from_not_allowed"
  if (row.automated) return null
  const [author] = row.authorUserId
    ? await tx
        .select({ id: authUser.id, role: authUser.role, banned: authUser.banned })
        .from(authUser)
        .where(eq(authUser.id, row.authorUserId))
    : []
  if (!author || author.banned) return "author_not_allowed"
  const scope = await visibleOrganizations(tx, { id: author.id, role: author.role ?? "agent" })
  return inScope(scope, row.organizationId) ? null : "author_not_allowed"
}
