// A user's subscriptions on their devices (plan 4.5). Every statement is the signed-in user's own: the owner comes
// from the session, a row of another user is never read, changed, or deleted here, and no answer holds an endpoint or
// a key. A device whose endpoint another user still holds (that user's session ended without signing out) is refused:
// the browser drops its subscription and makes a new one, with a new endpoint.

import type { Locale } from "@maane/shared"
import { and, eq, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { pushSubscription } from "../db/schema.ts"
import { Refusal } from "../organizations/refusal.ts"
import { pushEndpointAllowed, subscriptionKeysValid } from "./push.ts"

export type SubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string }; locale: Locale }

export class Subscriptions {
  constructor(private readonly db: Db) {}

  /** Whether this endpoint is one of the user's subscriptions (the device's own state). */
  async isOn(userId: string, endpoint: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: pushSubscription.id })
      .from(pushSubscription)
      .where(and(eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)))
    return row !== undefined
  }

  /**
   * Keeps the device's subscription for the user: new, or the user's own one with the browser's current keys and the
   * UI's language. An endpoint of a push service Maane does not send to is refused, and so is one another user holds.
   */
  async subscribe(userId: string, input: SubscriptionInput): Promise<void> {
    if (!pushEndpointAllowed(input.endpoint)) throw new Refusal("push_endpoint_refused", 400)
    if (!subscriptionKeysValid(input.keys.p256dh, input.keys.auth)) throw new Refusal("push_subscription_invalid", 400)
    // One statement: a row of another user is left exactly as it is, and then nothing comes back.
    const rows = await this.db
      .insert(pushSubscription)
      .values({
        userId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        locale: input.locale,
      })
      .onConflictDoUpdate({
        target: pushSubscription.endpoint,
        set: { p256dh: input.keys.p256dh, auth: input.keys.auth, locale: input.locale, updatedAt: sql`now()` },
        setWhere: eq(pushSubscription.userId, userId),
      })
      .returning({ id: pushSubscription.id })
    if (rows.length === 0) throw new Refusal("push_endpoint_taken", 409)
  }

  /** Removes the device's subscription when it is the user's; anything else is left alone. */
  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.db
      .delete(pushSubscription)
      .where(and(eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)))
  }
}
