import {
  type AddressKind,
  type CategoryRef,
  type CategoryView,
  defaultStatusFilter,
  type GraphTestView,
  type ImportMappingInput,
  type ImportReportPage,
  type ImportRunView,
  type ImportView,
  type IntakeLog,
  type Locale,
  type ReplyInput,
  type Role,
  type ScannerStatusView,
  type ScannerTestView,
  type ScheduledInput,
  type SettingKey,
  type SettingView,
  type SmtpTestView,
  type StatusFilter,
  type TicketList,
  type TicketStatus,
  type TicketView,
  type UploadView,
  type WebhookSecretsView,
} from "@maane/shared"
import { query, request, sendFile } from "./client.ts"

export type SetupStatus = {
  hasUser: boolean
  open: boolean
  closesInSeconds: number
  defaultLocale: Locale
}

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

export type OrganizationSummary = {
  id: string
  name: string
  createdAt: string
  addresses: number
  members: number
  hasDefault: boolean
}

export type SupportAddress = { id: string; kind: AddressKind; value: string; isDefault: boolean; createdAt: string }
export type OrganizationMember = { userId: string; username: string; role: string; banned: boolean; createdAt: string }

export type OrganizationDetail = {
  organization: {
    id: string
    name: string
    signature: string
    reminderTemplate: string
    reminderDays: number
    createdAt: string
  }
  addresses: SupportAddress[]
  members: OrganizationMember[]
}

export type AddressCheck = {
  address: string
  via: "exact" | "pattern" | "default" | "none"
  organization: { id: string; name: string } | null
  rule: { id: string; kind: AddressKind; value: string } | null
}

const ORGANIZATIONS = "/admin/organizations"
const at = (id: string) => `${ORGANIZATIONS}/${encodeURIComponent(id)}`

export type NotificationState = { publicKey: string; on: boolean }

export const qk = {
  setupStatus: ["setup-status"] as const,
  me: ["me"] as const,
  settings: ["settings"] as const,
  scanner: ["settings", "scanner"] as const,
  audit: ["audit"] as const,
  users: ["users"] as const,
  sessions: ["sessions"] as const,
  notifications: ["notifications"] as const,
  organizations: ["organizations"] as const,
  organization: (id: string) => ["organizations", id] as const,
  tickets: (filters: TicketFilters) =>
    [
      "tickets",
      filters.organization ?? "",
      filters.flagged ? 1 : 0,
      filters.status ?? "",
      filters.category ?? "",
      filters.q ?? "",
    ] as const,
  categories: ["categories"] as const,
  ticket: (number: number) => ["ticket", number] as const,
  intake: (filters: IntakeFilters) => ["intake", filters.flagged ? 1 : 0] as const,
  importPage: ["import"] as const,
  importRun: ["import", "run"] as const,
  importReport: (runId: string) => ["import", "report", runId] as const,
}

export type TicketFilters = {
  organization?: string
  flagged?: boolean
  status?: StatusFilter
  category?: string
  q?: string
}
export type IntakeFilters = { flagged?: boolean }

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
  scannerStatus: () => request<{ status: ScannerStatusView | null }>("GET", "/settings/scanner"),
  testScanner: () => request<{ id: string }>("POST", "/settings/scanner/test"),
  scannerTest: (id: string) => request<ScannerTestView>("GET", `/settings/scanner/test/${encodeURIComponent(id)}`),
  testGraph: () => request<{ id: string }>("POST", "/settings/graph/test"),
  graphTest: (id: string) => request<GraphTestView>("GET", `/settings/graph/test/${encodeURIComponent(id)}`),
  testSmtp: (provider: "smtp2go" | "failover") => request<{ id: string }>("POST", `/settings/smtp/${provider}/test`),
  smtpTest: (id: string) => request<SmtpTestView>("GET", `/settings/smtp/test/${encodeURIComponent(id)}`),
  generateWebhook: () => request<WebhookSecretsView>("POST", "/settings/smtp2go/webhook"),
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
      `/tickets${query({
        organization: filters.organization,
        flagged: filters.flagged ? 1 : undefined,
        status: filters.status === defaultStatusFilter(Boolean(filters.q)) ? undefined : filters.status,
        category: filters.category,
        q: filters.q,
        after,
      })}`,
    ),
  ticket: (number: number) => request<TicketView>("GET", `/tickets/${number}`),
  setStatus: (number: number, status: TicketStatus) =>
    request<{ ok: true }>("PUT", `/tickets/${number}/status`, { status }),
  setTicketCategories: (number: number, categories: string[]) =>
    request<{ ok: true }>("PUT", `/tickets/${number}/categories`, { categories }),
  moveTicket: (number: number, organizationId: string) =>
    request<{ ok: true }>("PUT", `/tickets/${number}/organization`, { organizationId }),
  categories: () => request<{ categories: CategoryView[] }>("GET", "/admin/categories"),
  createCategory: (name: string) => request<{ category: CategoryRef }>("POST", "/admin/categories", { name }),
  renameCategory: (id: string, name: string) =>
    request<{ ok: true }>("PATCH", `/admin/categories/${encodeURIComponent(id)}`, { name }),
  deleteCategory: (id: string) => request<{ ok: true }>("DELETE", `/admin/categories/${encodeURIComponent(id)}`),
  importPage: () => request<ImportView>("GET", "/admin/import"),
  saveImportMapping: (input: ImportMappingInput) => request<{ ok: true }>("PUT", "/admin/import/mapping", input),
  importRun: () => request<{ run: ImportRunView | null }>("GET", "/admin/import/run"),
  startImport: () => request<{ run: ImportRunView }>("POST", "/admin/import/start"),
  finishImport: () => request<ImportView>("POST", "/admin/import/finish"),
  cancelImport: (runId: string) =>
    request<{ run: ImportRunView | null; cancelled: boolean }>("POST", "/admin/import/cancel", { runId }),
  importReport: (runId: string, after: string | null) =>
    request<ImportReportPage>(
      "GET",
      `/admin/import/runs/${encodeURIComponent(runId)}/report${query({ after: after ?? undefined })}`,
    ),
  intake: (filters: IntakeFilters, after: string | null) =>
    request<IntakeLog>("GET", `/intake${query({ flagged: filters.flagged ? 1 : undefined, after })}`),
  writeMessage: (number: number, input: ReplyInput) =>
    request<{ id: string } | { scheduled: string }>("POST", `/tickets/${number}/messages`, input),
  changeScheduled: (id: string, input: ScheduledInput) =>
    request<{ ok: true }>("PUT", `/scheduled/${encodeURIComponent(id)}`, input),
  cancelScheduled: (id: string) => request<{ ok: true }>("POST", `/scheduled/${encodeURIComponent(id)}/cancel`),
  snooze: (number: number, until: string) => request<{ ok: true }>("PUT", `/tickets/${number}/snooze`, { until }),
  wake: (number: number) => request<{ ok: true }>("DELETE", `/tickets/${number}/snooze`),
  resend: (messageId: string) => request<{ ok: true }>("POST", `/messages/${encodeURIComponent(messageId)}/resend`),
  markSent: (messageId: string, address: string) =>
    request<{ ok: true }>("POST", `/messages/${encodeURIComponent(messageId)}/mark-sent`, { address }),
  upload: (file: File) => sendFile<UploadView>("/uploads", file),
  uploadState: (id: string) => request<UploadView>("GET", `/uploads/${encodeURIComponent(id)}`),
  setSignature: (id: string, signature: string) => request<{ ok: true }>("PUT", `${at(id)}/signature`, { signature }),
  setReminder: (id: string, template: string, days: number) =>
    request<{ ok: true }>("PUT", `${at(id)}/reminder`, { template, days }),
  setAgentName: (userId: string, name: string) =>
    request<{ ok: true }>("PUT", `/admin/users/${encodeURIComponent(userId)}/name`, { name }),
  checkAddress: (address: string) =>
    request<AddressCheck>("GET", `${ORGANIZATIONS}/address-check${query({ address })}`),
  notificationState: (endpoint: string | null, locale?: Locale) =>
    request<NotificationState>("POST", "/notifications/state", { endpoint, locale }),
  subscribeDevice: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, locale: Locale) =>
    request<{ on: true }>("PUT", "/notifications/subscription", { ...subscription, locale }),
  unsubscribeDevice: (endpoint: string) =>
    request<{ on: false }>("DELETE", "/notifications/subscription", { endpoint }),
}
