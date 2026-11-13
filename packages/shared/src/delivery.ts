// Delivery status and bounces (plan 3.3): what happened to a reply after a provider accepted it, per recipient. The
// words the server, the worker, and the UI share.

/**
 * What a recipient's mail server did with an accepted reply, as SMTP2GO reports it (its webhook and its activity
 * search) or as a failover bounce in the intake mailbox says:
 * - `delivered`: the recipient's server took it.
 * - `soft_bounce`: a temporary failure; the provider may still deliver it.
 * - `hard_bounce`: a permanent failure (also every `failed` recipient of a delivery report from the failover).
 * - `rejected`: the provider refused to send it (for example a suppressed address).
 * - `spam`: the recipient marked it as spam.
 */
export const DELIVERY_STATUSES = ["delivered", "soft_bounce", "hard_bounce", "rejected", "spam"] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

/** A status nothing later changes in practice: the activity poll stops asking about such a recipient. */
export const FINAL_DELIVERY_STATUSES: readonly DeliveryStatus[] = ["delivered", "hard_bounce", "rejected", "spam"]

/** A status that flags the ticket: a bounce, a rejection, or a spam report. */
export const FAILED_DELIVERY_STATUSES: readonly DeliveryStatus[] = ["soft_bounce", "hard_bounce", "rejected", "spam"]

/** Where a status came from: SMTP2GO's webhook, its activity search, or a delivery report in the intake mailbox. */
export const DELIVERY_SOURCES = ["webhook", "activity", "report"] as const
export type DeliverySource = (typeof DELIVERY_SOURCES)[number]

/** The longest provider text kept with a status (its reason or the report's status code). */
export const DELIVERY_DETAIL_MAX = 500

/**
 * How far back the activity poll looks: recipients accepted longer ago are left as they are, and the poll's window
 * never starts earlier than this.
 */
export const DELIVERY_POLL_MAX_AGE_DAYS = 7

/** The SMTP2GO webhook's address and secret header value, shown once when they are made. */
export interface WebhookSecretsView {
  /** The full URL to give SMTP2GO, its secret path included. */
  url: string
  /** The value of the `Authorization` header: SMTP2GO's "Bearer" type with this token. */
  token: string
}
