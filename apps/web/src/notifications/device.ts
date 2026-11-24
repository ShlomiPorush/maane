export type DeviceSubscription = {
  endpoint: string
  keys: { p256dh: string; auth: string }
  unsubscribe(): Promise<void>
}

export class DeviceRefusal extends Error {
  constructor(readonly reason: "unsupported" | "blocked") {
    super(reason)
    this.name = "DeviceRefusal"
  }
}

export interface PushDevice {
  supported(): boolean
  permission(): NotificationPermission
  current(): Promise<DeviceSubscription | null>
  subscribe(publicKey: string): Promise<DeviceSubscription>
}

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

export function registerServiceWorker(): void {
  if (!browserDevice.supported()) return
  navigator.serviceWorker.register("/sw.js").catch(() => {})
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

export function setPushDevice(next: PushDevice): void {
  device = next
}
