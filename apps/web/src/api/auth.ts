// The Better Auth client: setup, sign-in, two-factor, the password, the sessions, and the admin routes, all on
// Better Auth's own routes under /api/auth, through its documented React client and client plugins. Maane adds
// nothing to these requests: Better Auth checks the origin itself. Its useSession is the only thing that extends a
// session (deferSessionRefresh on the server): it refreshes when the page opens, comes back to the front or online,
// or another tab changes the session. Never call getSession from background polling, and keep refetchInterval at 0.
// A 401 answer is reported to the app through the client's documented fetchOptions.onError (it only observes; the
// answer reaches the caller unchanged): the app then asks Maane's API who is signed in, and goes to sign-in when no
// one is. A wrong password or code also answers 401 and stays an ordinary error, because the session is still there.

import { adminClient, twoFactorClient, usernameClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"
import { ac, roles } from "./access.ts"

let unauthorizedHandler: (() => void) | null = null

/** Called on each 401 from Better Auth's routes: the app checks whether the session is gone. */
export function onAuthUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

/** What the client's onError reports about a failed answer. */
export function noteAuthStatus(status: number): void {
  if (status === 401) unauthorizedHandler?.()
}

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [usernameClient(), twoFactorClient(), adminClient({ ac, roles })],
  sessionOptions: { refetchInterval: 0 },
  fetchOptions: {
    onError: (context) => noteAuthStatus(context.response.status),
  },
})

/** A failed Better Auth answer: its status (none when no answer came), its code and its message. */
export type AuthError = { status?: number; code?: string; message?: string } | null | undefined

/** Turns a Better Auth client answer into its data, or throws its error (for TanStack Query and try blocks). */
export async function authData<T>(call: Promise<{ data: T | null; error: AuthError }>): Promise<T> {
  let answer: { data: T | null; error: AuthError }
  try {
    answer = await call
  } catch {
    throw new AuthCallError({})
  }
  if (answer.error) throw new AuthCallError(answer.error)
  if (answer.data === null) throw new AuthCallError({ status: 500 })
  return answer.data
}

export class AuthCallError extends Error {
  override name = "AuthCallError"
  constructor(readonly answer: NonNullable<AuthError>) {
    super(answer.code ?? String(answer.status ?? "network"))
  }
}
