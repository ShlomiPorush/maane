export const DELIVERY_STATUSES = ["delivered", "soft_bounce", "hard_bounce", "rejected", "spam"] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

export const FINAL_DELIVERY_STATUSES: readonly DeliveryStatus[] = ["delivered", "hard_bounce", "rejected", "spam"]

export const FAILED_DELIVERY_STATUSES: readonly DeliveryStatus[] = ["soft_bounce", "hard_bounce", "rejected", "spam"]

export const DELIVERY_SOURCES = ["webhook", "activity", "report"] as const
export type DeliverySource = (typeof DELIVERY_SOURCES)[number]

export const DELIVERY_DETAIL_MAX = 500

export const DELIVERY_POLL_MAX_AGE_DAYS = 7

export interface WebhookSecretsView {
  url: string
  token: string
}
