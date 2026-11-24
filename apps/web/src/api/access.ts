import { createAccessControl } from "better-auth/plugins/access"
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access"

export const ac = createAccessControl({ ...defaultStatements } as const)
export const roles = {
  admin: ac.newRole({ ...adminAc.statements }),
  agent: ac.newRole({ user: [], session: [] }),
}
