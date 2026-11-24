import { useQuery } from "@tanstack/react-query"
import type { ApiError } from "../api/client.ts"
import { api, qk } from "../api/endpoints.ts"

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

export function useSetupStatus({ fresh = false }: { fresh?: boolean } = {}) {
  return useQuery({
    queryKey: qk.setupStatus,
    queryFn: api.setupStatus,
    retry: false,
    staleTime: fresh ? 0 : 60_000,
    refetchOnMount: fresh ? "always" : true,
  })
}

export const AUTH_PAGES = ["/login", "/setup", "/enroll"]

export function safeNext(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || value.length > 2048) return "/"
  if (/^\/(login|setup|enroll|api)(\/|\?|$)/.test(value)) return "/"
  return value
}

export function withNext(page: string, next: string): string {
  return next === "/" ? page : `${page}?next=${encodeURIComponent(next)}`
}

export function authPath(error: ApiError, here: string): string {
  return withNext(error.code === "totp_required" ? "/enroll" : "/login", safeNext(here))
}

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
