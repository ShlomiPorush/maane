// Who is signed in, as Maane's API sees them (GET /api/v1/me), and where an unauthorized answer sends the page. The
// role is read on every request on the server; the UI uses it only to show or hide admin pages, never to decide.

import { useQuery } from "@tanstack/react-query"
import type { ApiError } from "../api/client.ts"
import { api, qk } from "../api/endpoints.ts"

/** The signed-in user. `fresh` reads it again on mount (the sign-in pages, which decide where to go by it). */
export function useMe({ fresh = false }: { fresh?: boolean } = {}) {
  return useQuery({
    queryKey: qk.me,
    queryFn: api.me,
    retry: false,
    staleTime: fresh ? 0 : Number.POSITIVE_INFINITY,
    refetchOnMount: fresh ? "always" : true,
    refetchOnWindowFocus: false,
  })
}

/** Whether a user exists, whether setup is open, and the default language. */
export function useSetupStatus({ fresh = false }: { fresh?: boolean } = {}) {
  return useQuery({
    queryKey: qk.setupStatus,
    queryFn: api.setupStatus,
    retry: false,
    staleTime: fresh ? 0 : 60_000,
    refetchOnMount: fresh ? "always" : true,
  })
}

/** The pages that work without a full session. */
export const AUTH_PAGES = ["/login", "/setup", "/enroll"]

/** Only a local path of this app is a place to come back to after signing in. */
export function safeNext(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || value.length > 2048) return "/"
  if (/^\/(login|setup|enroll|api)(\/|\?|$)/.test(value)) return "/"
  return value
}

/** A page with `next` added when it is not the home page. */
export function withNext(page: string, next: string): string {
  return next === "/" ? page : `${page}?next=${encodeURIComponent(next)}`
}

/** Where a 401 or totp_required takes the page: sign-in, or the two-factor setup. */
export function authPath(error: ApiError, here: string): string {
  return withNext(error.code === "totp_required" ? "/enroll" : "/login", safeNext(here))
}

// The password typed at sign-in or setup, held in memory only (never in storage or history) so the two-factor setup
// that follows starts without asking for it again. It is forgotten as soon as the setup starts or the page reloads.
let enrollmentPassword: string | null = null

export function rememberForEnrollment(password: string): void {
  enrollmentPassword = password
}

export function peekEnrollmentPassword(): string | null {
  return enrollmentPassword
}

export function forgetEnrollmentPassword(): void {
  enrollmentPassword = null
}
