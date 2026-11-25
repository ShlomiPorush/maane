import type { Locale } from "@maane/shared"
import { api } from "../api/endpoints.ts"
import { pushDevice } from "./device.ts"

let registering = 0
let started = 0

export async function whileRegistering<T>(work: () => Promise<T>): Promise<T> {
  registering += 1
  started += 1
  try {
    return await work()
  } finally {
    registering -= 1
  }
}

export class DeviceNotForgotten extends Error {
  constructor(cause: unknown) {
    super("the browser could not end its push subscription", { cause })
    this.name = "DeviceNotForgotten"
  }
}

export async function forgetDevice(): Promise<void> {
  const device = pushDevice()
  if (!device.supported()) return
  const subscription = await device.current().catch((error: unknown) => {
    throw new DeviceNotForgotten(error)
  })
  if (!subscription) return
  await api.unsubscribeDevice(subscription.endpoint).catch(() => {})
  await subscription.unsubscribe().catch((error: unknown) => {
    throw new DeviceNotForgotten(error)
  })
}

export async function followSubscription(language: Locale): Promise<boolean> {
  const device = pushDevice()
  if (!device.supported()) return false
  if (registering > 0) throw new Error("a subscription is being registered")
  const before = started
  const subscription = await device.current()
  if (!subscription) return false
  const { on } = await api.notificationState(subscription.endpoint, language)
  if (on === true) return false
  if (on !== false) throw new Error("the notification state has no answer")
  if (started !== before) throw new Error("a subscription is being registered")
  const now = await device.current()
  if (now?.endpoint !== subscription.endpoint) return false
  await now.unsubscribe()
  return true
}
