// Maane's own API, typed, and the TanStack Query keys of each read.

import type {
  AddressKind,
  GraphTestView,
  IntakeLog,
  Locale,
  ReplyInput,
  Role,
  ScannerStatusView,
  ScannerTestView,
  SettingKey,
  SettingView,
  SmtpTestView,
  TicketList,
  TicketView,
  UploadView,
} from "@maane/shared"
import { query, request, sendFile } from "./client.ts"

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
  organization: { id: string; name: string; signature: string; createdAt: string }
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
  scanner: ["settings", "scanner"] as const,
  audit: ["audit"] as const,
  users: ["users"] as const,
  sessions: ["sessions"] as const,
  organizations: ["organizations"] as const,
  organization: (id: string) => ["organizations", id] as const,
  tickets: (filters: TicketFilters) => ["tickets", filters.organization ?? "", filters.flagged ? 1 : 0] as const,
  ticket: (number: number) => ["ticket", number] as const,
  intake: (filters: IntakeFilters) => ["intake", filters.mode ?? "", filters.flagged ? 1 : 0] as const,
}

/** The ticket list's filters, as the page keeps them in its address. */
export type TicketFilters = { organization?: string; flagged?: boolean }
/** The intake log's filters. */
export type IntakeFilters = { mode?: "listening" | "live"; flagged?: boolean }

/**
 * Where a message body, a download, and a preview are served: the frame and the links use these addresses. The body's
 * address carries its content version, so the frame reloads once a waiting part of it was decided.
 */
export const bodyUrl = (messageId: string, version: string, remoteImages: boolean) =>
  `/api/v1/messages/${encodeURIComponent(messageId)}/body${query({ v: version, images: remoteImages ? 1 : undefined })}`
export const downloadUrl = (attachmentId: string) => `/api/v1/files/${encodeURIComponent(attachmentId)}`
export const previewUrl = (attachmentId: string) => `/api/v1/files/${encodeURIComponent(attachmentId)}/preview`

export const api = {
  setupStatus: () => request<SetupStatus>("GET", "/api/setup/status"),
  me: () => request<Me>("GET", "/me"),
  settings: () => request<{ settings: SettingView[] }>("GET", "/settings"),
  saveSettings: (changes: Partial<Record<SettingKey, unknown>>) =>
    request<{ settings: SettingView[] }>("PUT", "/settings", changes),
  /** The scanner's latest self-test. */
  scannerStatus: () => request<{ status: ScannerStatusView | null }>("GET", "/settings/scanner"),
  /** Queues a connection test the worker runs; scannerTest reads where it is. */
  testScanner: () => request<{ id: string }>("POST", "/settings/scanner/test"),
  scannerTest: (id: string) => request<ScannerTestView>("GET", `/settings/scanner/test/${encodeURIComponent(id)}`),
  /** Queues a Graph connection test the worker runs; graphTest reads where it is. */
  testGraph: () => request<{ id: string }>("POST", "/settings/graph/test"),
  graphTest: (id: string) => request<GraphTestView>("GET", `/settings/graph/test/${encodeURIComponent(id)}`),
  /** Queues an SMTP connection test of one server the worker runs; smtpTest reads where it is. */
  testSmtp: (provider: "smtp2go" | "failover") => request<{ id: string }>("POST", `/settings/smtp/${provider}/test`),
  smtpTest: (id: string) => request<SmtpTestView>("GET", `/settings/smtp/test/${encodeURIComponent(id)}`),
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
  tickets: (filters: TicketFilters, after: string | null) =>
    request<TicketList>(
      "GET",
      `/tickets${query({ organization: filters.organization, flagged: filters.flagged ? 1 : undefined, after })}`,
    ),
  ticket: (number: number) => request<TicketView>("GET", `/tickets/${number}`),
  intake: (filters: IntakeFilters, after: string | null) =>
    request<IntakeLog>(
      "GET",
      `/intake${query({ mode: filters.mode, flagged: filters.flagged ? 1 : undefined, after })}`,
    ),
  /** A reply or an internal note; the same submission ID again finds the same message. */
  writeMessage: (number: number, input: ReplyInput) =>
    request<{ id: string }>("POST", `/tickets/${number}/messages`, input),
  resend: (messageId: string) => request<{ ok: true }>("POST", `/messages/${encodeURIComponent(messageId)}/resend`),
  markSent: (messageId: string) =>
    request<{ ok: true }>("POST", `/messages/${encodeURIComponent(messageId)}/mark-sent`),
  upload: (file: File) => sendFile<UploadView>("/uploads", file),
  uploadState: (id: string) => request<UploadView>("GET", `/uploads/${encodeURIComponent(id)}`),
  setSignature: (id: string, signature: string) => request<{ ok: true }>("PUT", `${at(id)}/signature`, { signature }),
  setAgentName: (userId: string, name: string) =>
    request<{ ok: true }>("PUT", `/admin/users/${encodeURIComponent(userId)}/name`, { name }),
  checkAddress: (address: string) =>
    request<AddressCheck>("GET", `${ORGANIZATIONS}/address-check${query({ address })}`),
}
