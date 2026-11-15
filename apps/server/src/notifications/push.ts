// Browser notifications (plan 4.5): where Maane may send a push, and what a browser's subscription must look like.
// The server checks an endpoint when a browser subscribes, and the worker checks it again right before each send.

/**
 * The push services of the browsers Maane supports, from each vendor's documentation. A host is allowed when it is
 * one of EXACT, or a subdomain of one of SUFFIXES (at a dot boundary).
 *
 * - Chrome, and Chromium browsers on Android: Firebase Cloud Messaging, `https://fcm.googleapis.com/fcm/send/...`
 *   (https://web.dev/articles/push-notifications-subscribing-a-user).
 * - Firefox: Mozilla's autopush, `https://updates.push.services.mozilla.com/...` (https://autopush.readthedocs.io/).
 * - Microsoft Edge: the Windows Push Notification Services, `https://<node>.notify.windows.com/w/?token=...`
 *   (https://learn.microsoft.com/windows/apps/design/shell/tiles-and-notifications/firewall-allowlist-config:
 *   `*.notify.windows.com`).
 * - Safari: Apple's push service, `https://web.push.apple.com/...` (https://developer.apple.com/documentation/
 *   usernotifications/sending-web-push-notifications-in-web-apps-and-browsers: subdomains of `push.apple.com`).
 */
const EXACT: ReadonlySet<string> = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com"])
const SUFFIXES = ["notify.windows.com", "push.apple.com"] as const

/** The longest endpoint Maane keeps; the browsers' endpoints are a few hundred characters. */
export const ENDPOINT_MAX = 2048

/**
 * Whether Maane may send to this endpoint: https on the default port, no user name or password, and a host of a
 * browser's push service. An address (IPv4 or IPv6), an internal name, or any other host is refused; so the check
 * never needs to resolve a name.
 */
export function pushEndpointAllowed(endpoint: string): boolean {
  if (endpoint.length === 0 || endpoint.length > ENDPOINT_MAX || !URL.canParse(endpoint)) return false
  const url = new URL(endpoint)
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return false
  const host = url.hostname.toLowerCase()
  return EXACT.has(host) || SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`))
}

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/

/** The browser's keys of a subscription: its P-256 public key (65 bytes) and its auth secret (16 bytes), base64url. */
export function subscriptionKeysValid(p256dh: string, auth: string): boolean {
  if (!BASE64URL.test(p256dh) || !BASE64URL.test(auth)) return false
  const point = Buffer.from(p256dh, "base64url")
  return point.length === 65 && point[0] === 4 && Buffer.from(auth, "base64url").length === 16
}
