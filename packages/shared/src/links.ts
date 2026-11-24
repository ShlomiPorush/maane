export const LINK_TRACKING = ["on", "off"] as const
export type LinkTracking = (typeof LINK_TRACKING)[number]

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`)

export function isLinkDomain(text: string): boolean {
  return text.length <= 253 && DOMAIN.test(text) && !/^[0-9.]+$/.test(text)
}

export const TRACKED_URL_MAX = 2048

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

export const DEVICE_TYPES = ["desktop", "mobile", "tablet", "bot", "other"] as const
export type DeviceType = (typeof DEVICE_TYPES)[number]

export const SCANNER_REASONS = ["early", "agent", "network"] as const
export type ScannerReason = (typeof SCANNER_REASONS)[number]

export const CLICKS_SHOWN = 50

export interface ClickView {
  id: number
  at: string
  ip: string | null
  country: string | null
  city: string | null
  region: string | null
  isp: string | null
  asn: number | null
  device: DeviceType | null
  os: string | null
  browser: string | null
  userAgent: string | null
  scanner: ScannerReason[]
}

export interface TrackedLinkView {
  id: string
  kind: "url" | "file"
  target: string
  total: number
  clicks: ClickView[]
}
