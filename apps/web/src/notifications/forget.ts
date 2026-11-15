// Signing out of this browser first removes this device's notifications (plan 4.5): Maane's API deletes the user's
// subscription, then the browser ends it at its push service. Called before Better Auth's documented signOut. And once
// a user is signed in, a subscription this browser still holds for someone else is ended (dropForeignSubscription).

import { api } from "../api/endpoints.ts"
import { pushDevice } from "./device.ts"

/** The browser could not read or end its subscription: notifications would still reach this device. */
export class DeviceNotForgotten extends Error {
  constructor(cause: unknown) {
    super("the browser could not end its push subscription", { cause })
    this.name = "DeviceNotForgotten"
  }
}

/**
 * Throws when this device's notifications could not be turned off; the sign-out then stops and says so. Ending the
 * subscription in the browser is what stops them: the push service then refuses the next send, and that refusal
 * deletes the row on the server too. So the browser ends it whatever the server's delete answered.
 */
export async function forgetDevice(): Promise<void> {
  const device = pushDevice()
  if (!device.supported()) return
  const subscription = await device.current().catch((error: unknown) => {
    throw new DeviceNotForgotten(error)
  })
  if (!subscription) return
  await api.unsubscribeDevice(subscription.endpoint).catch(() => {
    // The row goes on the next send instead, once the browser below has ended the subscription.
  })
  await subscription.unsubscribe().catch((error: unknown) => {
    throw new DeviceNotForgotten(error)
  })
}

/**
 * Ends a subscription this browser holds that the server does not count as the signed-in user's: one a previous user
 * left when their session ended without signing out, so their notifications would reach the next user of the browser.
 * Only a clear answer ends it; a failed check changes nothing, and the next start of the app checks again. Returns
 * whether it ended one.
 */
export async function dropForeignSubscription(): Promise<boolean> {
  const device = pushDevice()
  if (!device.supported()) return false
  const subscription = await device.current()
  if (!subscription) return false
  const { on } = await api.notificationState(subscription.endpoint)
  if (on) return false
  // The device may have subscribed again meanwhile (turned on in the Account page): only the endpoint asked about ends.
  const now = await device.current()
  if (now?.endpoint !== subscription.endpoint) return false
  await now.unsubscribe()
  return true
}
