import { adminClient, twoFactorClient, usernameClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"
import { ac, roles } from "./access.ts"

let unauthorizedHandler: (() => void) | null = null

export function onAuthUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

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

export type AuthError = { status?: number; code?: string; message?: string } | null | undefined

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
