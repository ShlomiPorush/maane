const EXACT: ReadonlySet<string> = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com"])
const SUFFIXES = ["notify.windows.com", "push.apple.com"] as const

export const ENDPOINT_MAX = 2048

export function pushEndpointAllowed(endpoint: string): boolean {
  if (endpoint.length === 0 || endpoint.length > ENDPOINT_MAX || !/^[!-~]+$/.test(endpoint)) return false
  if (!URL.canParse(endpoint)) return false
  const url = new URL(endpoint)
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return false
  const host = url.hostname.toLowerCase()
  return EXACT.has(host) || SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`))
}

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/

export function subscriptionKeysValid(p256dh: string, auth: string): boolean {
  if (!BASE64URL.test(p256dh) || !BASE64URL.test(auth)) return false
  const point = Buffer.from(p256dh, "base64url")
  return point.length === 65 && point[0] === 4 && Buffer.from(auth, "base64url").length === 16
}
