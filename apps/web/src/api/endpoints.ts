// Maane's own API, typed, and the TanStack Query keys of each read.

import type { AddressKind, Locale, Role, SettingKey, SettingView } from "@maane/shared"
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

/** An organization in the admin list. */
export type OrganizationSummary = {
  id: string
  name: string
  createdAt: string
  addresses: number
  members: number
  /** It holds the default address. */
  hasDefault: boolean
}

export type SupportAddress = { id: string; kind: AddressKind; value: string; isDefault: boolean; createdAt: string }
export type OrganizationMember = { userId: string; username: string; role: string; banned: boolean; createdAt: string }

export type OrganizationDetail = {
  organization: { id: string; name: string; createdAt: string }
  addresses: SupportAddress[]
  members: OrganizationMember[]
}

/** The answer to "Which organization gets this address?". */
export type AddressCheck = {
  address: string
  via: "exact" | "pattern" | "default" | "none"
  organization: { id: string; name: string } | null
  rule: { id: string; kind: AddressKind; value: string } | null
}

const ORGANIZATIONS = "/admin/organizations"
const at = (id: string) => `${ORGANIZATIONS}/${encodeURIComponent(id)}`

export const qk = {
  setupStatus: ["setup-status"] as const,
  me: ["me"] as const,
  settings: ["settings"] as const,
  audit: ["audit"] as const,
  users: ["users"] as const,
  sessions: ["sessions"] as const,
  organizations: ["organizations"] as const,
  organization: (id: string) => ["organizations", id] as const,
}

export const api = {
  setupStatus: () => request<SetupStatus>("GET", "/api/setup/status"),
  me: () => request<Me>("GET", "/me"),
  settings: () => request<{ settings: SettingView[] }>("GET", "/settings"),
  saveSettings: (changes: Partial<Record<SettingKey, unknown>>) =>
    request<{ settings: SettingView[] }>("PUT", "/settings", changes),
  audit: (before: number | null) =>
    request<AuditPage>("GET", `/audit${query({ before: before ?? undefined, limit: AUDIT_PAGE_SIZE })}`),
  organizations: () => request<{ organizations: OrganizationSummary[] }>("GET", ORGANIZATIONS),
  organization: (id: string) => request<OrganizationDetail>("GET", at(id)),
  createOrganization: (name: string) =>
    request<{ organization: { id: string; name: string } }>("POST", ORGANIZATIONS, { name }),
  renameOrganization: (id: string, name: string) => request<{ ok: true }>("PATCH", at(id), { name }),
  deleteOrganization: (id: string) => request<{ ok: true }>("DELETE", at(id)),
  addMember: (id: string, userId: string) => request<{ ok: true }>("POST", `${at(id)}/members`, { userId }),
  removeMember: (id: string, userId: string) =>
    request<{ ok: true }>("DELETE", `${at(id)}/members/${encodeURIComponent(userId)}`),
  addAddress: (id: string, kind: AddressKind, value: string) =>
    request<{ address: { id: string } }>("POST", `${at(id)}/addresses`, { kind, value }),
  removeAddress: (id: string, addressId: string) =>
    request<{ ok: true }>("DELETE", `${at(id)}/addresses/${encodeURIComponent(addressId)}`),
  setDefaultAddress: (id: string, addressId: string) =>
    request<{ ok: true }>("PUT", `${at(id)}/addresses/${encodeURIComponent(addressId)}/default`),
  checkAddress: (address: string) =>
    request<AddressCheck>("GET", `${ORGANIZATIONS}/address-check${query({ address })}`),
}
