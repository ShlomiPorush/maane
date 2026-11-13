// The words of link tracking and download links (plan 3.4, requirements 3.4 and 4.3) that the server and the UI share:
// the bounds of what a click records, why a click may come from a scanner, and the shape the ticket view shows.

/** Whether Maane rewrites the links an agent writes and records clicks and downloads (links.tracking). */
export const LINK_TRACKING = ["on", "off"] as const
export type LinkTracking = (typeof LINK_TRACKING)[number]

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`)

/**
 * The link domain (links.domain): a host name with at least one dot, such as `links.example.com`, without a scheme,
 * port, or path. Links and downloads are served from https://<link domain>.
 */
export function isLinkDomain(text: string): boolean {
  return text.length <= 253 && DOMAIN.test(text) && !/^[0-9.]+$/.test(text)
}

/** The longest URL Maane tracks; a longer link stays as the agent wrote it. */
export const TRACKED_URL_MAX = 2048

/** The bounds, in characters, of every string a click or a download records. */
export const CLICK_BOUNDS = {
  ip: 45,
  country: 2,
  city: 120,
  region: 120,
  isp: 200,
  device: 20,
  os: 60,
  browser: 60,
  userAgent: 1000,
} as const

/** Kinds of device, from the user agent: a known crawler or scanner is a `bot`. */
export const DEVICE_TYPES = ["desktop", "mobile", "tablet", "bot", "other"] as const
export type DeviceType = (typeof DEVICE_TYPES)[number]

/**
 * Why a click may come from a security scanner, not the customer (requirements 3.4). A mark of uncertainty, not a
 * verdict:
 * - `early`: within the first seconds after the reply was delivered (or sent, when no delivery time is known).
 * - `agent`: the user agent of a known crawler or scanner.
 * - `network`: from the network (AS) of a provider known to scan links in mail.
 */
export const SCANNER_REASONS = ["early", "agent", "network"] as const
export type ScannerReason = (typeof SCANNER_REASONS)[number]

/** One click on a link, or one download of a file. */
export interface ClickView {
  id: number
  at: string
  ip: string | null
  /** ISO 3166-1 alpha-2, in lower case, or null. */
  country: string | null
  city: string | null
  region: string | null
  isp: string | null
  asn: number | null
  device: DeviceType | null
  os: string | null
  browser: string | null
  userAgent: string | null
  /** Empty when nothing suggests a scanner. */
  scanner: ScannerReason[]
}

/** A link of an outgoing reply that was clicked, or a history file that was downloaded, with its clicks newest first. */
export interface TrackedLinkView {
  kind: "url" | "file"
  /** The original URL, or the file's name. */
  target: string
  clicks: ClickView[]
}
