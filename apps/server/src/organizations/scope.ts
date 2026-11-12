// The one scope function (plan 2.1): which organizations a user may see. Every ticket, message, and file query of
// later phases takes its result, and the worker uses it for sessionless checks. Membership is read from the
// database on each call, never cached, so removing an agent from an organization takes effect on the next request.

import { eq } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { organizationMember } from "../db/schema.ts"

/** Every organization (an admin), or exactly these (an agent; possibly none). */
export type OrganizationScope = { all: true } | { all: false; organizationIds: string[] }

export async function visibleOrganizations(
  db: Pick<Db, "select">,
  user: { id: string; role: string },
): Promise<OrganizationScope> {
  if (user.role === "admin") return { all: true }
  const rows = await db
    .select({ organizationId: organizationMember.organizationId })
    .from(organizationMember)
    .where(eq(organizationMember.userId, user.id))
  return { all: false, organizationIds: rows.map((row) => row.organizationId).sort() }
}

/** Whether a scope includes one organization. */
export function inScope(scope: OrganizationScope, organizationId: string): boolean {
  return scope.all || scope.organizationIds.includes(organizationId)
}
