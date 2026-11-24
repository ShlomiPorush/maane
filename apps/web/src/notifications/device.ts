// This browser's side of notifications (plan 4.5): the service worker Maane registers at /sw.js, the permission, and
// the push subscription. Behind one replaceable object, so component tests (happy-dom has no push) give their own.

/** A push subscription as Maane's API takes it, and the way to end it in this browser. */
export type DeviceSubscription = {
  endpoint: string
  keys: { p256dh: string; auth: string }
  /** Ends the subscription at the browser's push service, so nothing reaches this browser through it again. */
  unsubscribe(): Promise<void>
}

/** Why this browser cannot turn notifications on. */
export class DeviceRefusal extends Error {
  constructor(readonly reason: "unsupported" | "blocked") {
    super(reason)
    this.name = "DeviceRefusal"
  }
}

export interface PushDevice {
  /** Whether this browser can get push notifications here at all. */
  supported(): boolean
  /** The browser's notification permission: "denied" means the user blocked Maane in the browser's settings. */
  permission(): NotificationPermission
  current(): Promise<DeviceSubscription | null>
  /** Asks for the permission when needed and subscribes with Maane's public key. */
  subscribe(publicKey: string): Promise<DeviceSubscription>
}

/** How long the service worker may take to become active before subscribing gives up. */
const READY_TIMEOUT_MS = 15_000

const toBytes = (base64url: string) => {
  const text = atob(
    base64url
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(base64url.length / 4) * 4, "="),
  )
  return Uint8Array.from(text, (char) => char.charCodeAt(0))
}

function view(subscription: PushSubscription): DeviceSubscription {
  const json = subscription.toJSON()
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
    unsubscribe: async () => {
      await subscription.unsubscribe()
    },
  }
}

/** Registers Maane's service worker (it shows notifications and opens their ticket, nothing else). */
export function registerServiceWorker(): void {
  if (!browserDevice.supported()) return
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Without it the Account page says notifications cannot be turned on; the rest of the app works.
  })
}

async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js")
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeviceRefusal("unsupported")), READY_TIMEOUT_MS)
  })
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export const browserDevice: PushDevice = {
  supported: () =>
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window,
  permission: () => Notification.permission,
  current: async () => {
    const registration = await navigator.serviceWorker.getRegistration("/")
    const subscription = await registration?.pushManager.getSubscription()
    return subscription ? view(subscription) : null
  },
  subscribe: async (publicKey) => {
    const permission =
      Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission
    if (permission !== "granted") throw new DeviceRefusal("blocked")
    const registration = await activeRegistration()
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: toBytes(publicKey),
    })
    return view(subscription)
  },
}

let device: PushDevice = browserDevice

export function pushDevice(): PushDevice {
  return device
}

/** Replaces the browser's push side (tests). */
export function setPushDevice(next: PushDevice): void {
  device = next
}
