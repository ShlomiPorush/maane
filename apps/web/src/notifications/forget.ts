// Signing out of this browser first removes this device's notifications (plan 4.5): Maane's API deletes the user's
// subscription, then the browser ends it at its push service. Called before Better Auth's documented signOut.

import { ApiError } from "../api/client.ts"
import { api } from "../api/endpoints.ts"
import { pushDevice } from "./device.ts"

/** Throws when Maane could not remove the subscription; the sign-out then stops and says so. */
export async function forgetDevice(): Promise<void> {
  const device = pushDevice()
  if (!device.supported()) return
  const subscription = await device.current().catch(() => null)
  if (!subscription) return
  try {
    await api.unsubscribeDevice(subscription.endpoint)
  } catch (error) {
    // A session /api/v1 no longer takes (it ended, or two-factor is not set up yet) cannot remove its row. Ending the
    // browser's subscription below makes the push service refuse the next send, and that refusal deletes the row.
    if (!(error instanceof ApiError && (error.status === 401 || error.code === "totp_required"))) throw error
  }
  await subscription.unsubscribe().catch(() => {})
}
