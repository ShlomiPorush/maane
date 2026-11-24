import { eq } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { organizationMember } from "../db/schema.ts"

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

export function inScope(scope: OrganizationScope, organizationId: string): boolean {
  return scope.all || scope.organizationIds.includes(organizationId)
}
