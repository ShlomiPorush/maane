// Maane's two roles as the admin plugin documents custom access control for its client: an admin has the plugin's
// admin permissions, an agent none. The same map as the server's (apps/server/src/auth/auth.ts); the client uses it
// to type the role in its requests. The server decides every permission on its own.

import { createAccessControl } from "better-auth/plugins/access"
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access"

export const ac = createAccessControl({ ...defaultStatements } as const)
export const roles = {
  admin: ac.newRole({ ...adminAc.statements }),
  agent: ac.newRole({ user: [], session: [] }),
}
