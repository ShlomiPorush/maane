// The send point's checks of a reply (plan 3.1), shared by the sender's claim and a timed action at its time (plan 4.2):
// intake is live, the From address still belongs to the ticket's organization, and the author may still answer the
// ticket (not banned, and the organization still in their scope, read again now). Kept apart from the reply service so
// the worker never loads sharp.

import type { SendProblem } from "@maane/shared"
import { eq } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { authUser } from "../db/schema.ts"
import { inScope, visibleOrganizations } from "../organizations/scope.ts"
import { belongsTo, supportRules } from "./rules.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** Why the send point refuses this reply now, or null: listening, a From address or an author no longer allowed. */
export async function sendProblem(
  tx: Pick<Tx, "select">,
  mode: string,
  row: { from: string; organizationId: string; authorUserId: string | null },
): Promise<Extract<SendProblem, "listening" | "from_not_allowed" | "author_not_allowed"> | null> {
  if (mode !== "live") return "listening"
  if (!belongsTo(row.from, await supportRules(tx), row.organizationId)) return "from_not_allowed"
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
