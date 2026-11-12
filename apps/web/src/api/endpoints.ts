// Maane's own API, typed, and the TanStack Query keys of each read.

import type { Locale, Role, SettingKey, SettingView } from "@maane/shared"
import { query, request } from "./client.ts"

export type SetupStatus = {
  hasUser: boolean
  /** Setup is open: no user exists and the window after the server start has not passed. */
  open: boolean
  closesInSeconds: number
  /** The language the UI starts in, unless this browser chose one. */
  defaultLocale: Locale
}

/** The signed-in user, as Maane's API sees them (a full session: two-factor on). */
export type Me = { id: string; username: string; role: Role | string }

export type AuditEntry = {
  id: number
  at: string
  actorUserId: string | null
  actorLabel: string
  action: string
  entityType: string | null
  entityId: string | null
  details: Record<string, unknown> | null
  ipAddress: string | null
}

export type AuditPage = { entries: AuditEntry[]; next: number | null }

export const AUDIT_PAGE_SIZE = 50

export const qk = {
  setupStatus: ["setup-status"] as const,
  me: ["me"] as const,
  settings: ["settings"] as const,
  audit: ["audit"] as const,
  users: ["users"] as const,
  sessions: ["sessions"] as const,
}

export const api = {
  setupStatus: () => request<SetupStatus>("GET", "/api/setup/status"),
  me: () => request<Me>("GET", "/me"),
  settings: () => request<{ settings: SettingView[] }>("GET", "/settings"),
  saveSettings: (changes: Partial<Record<SettingKey, unknown>>) =>
    request<{ settings: SettingView[] }>("PUT", "/settings", changes),
  audit: (before: number | null) =>
    request<AuditPage>("GET", `/audit${query({ before: before ?? undefined, limit: AUDIT_PAGE_SIZE })}`),
}
